import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, lstat, mkdir, readFile, readdir, realpath, writeAtomic } from "@toonflow/file";

// Offline operator tool: stop every writer first. The flag acknowledges this; it is not a process lock.
const [operation, sourceArg, targetArg, confirmation] = process.argv.slice(2);
if (!["backup", "restore"].includes(operation ?? "") || !sourceArg || !targetArg || confirmation !== "--offline-confirmed") {
  throw new Error("Usage: bun apps/server/scripts/dataBackup.ts backup|restore SOURCE NEW_TARGET --offline-confirmed");
}
const password = process.env.TOONFLOW_BACKUP_PASSWORD;
if (!password || password.length < 16) throw new Error("TOONFLOW_BACKUP_PASSWORD must contain at least 16 characters; supply it through the environment, not arguments.");
const source = await realpath(resolve(sourceArg));
const target = resolve(await realpath(dirname(resolve(targetArg))), resolve(targetArg).split(/[\\/]/).at(-1)!);
function within(root: string, path: string) {
  const offset = relative(root, path);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}
if (within(source, target) || within(target, source)) throw new Error("Source and destination must be separate directories.");

type Entry = { path: string; size: number; hash: string; iv: string; tag: string };
type Manifest = { version: number; createdAt: string; originalDirectory: string; directories: string[]; files: Entry[] };
const pending = new Set(["queued", "running", "saving", "cancelling"]);

async function walk(root: string, folder = "", files: string[] = [], directories: string[] = []) {
  for (const name of await readdir(join(root, folder))) {
    const path = folder ? `${folder}/${name}` : name;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path}`);
    if (info.isDirectory()) {
      directories.push(path);
      await walk(root, path, files, directories);
    } else if (info.isFile()) files.push(path);
    else throw new Error(`Unsupported file: ${path}`);
  }
  return { files, directories };
}

async function encrypt(input: string, output: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(createReadStream(input), meter, cipher, createWriteStream(output, { flags: "wx", mode: 0o600 }));
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), size, hash: hash.digest("hex") };
}

if (operation === "backup") {
  const listing = await walk(source);
  if (!listing.files.includes("settings.json")) throw new Error("Source must be the complete application data directory containing settings.json.");
  if (listing.files.includes("projects.json")) {
    const projects: unknown = JSON.parse(await readFile(join(source, "projects.json"), "utf8"));
    if (!Array.isArray(projects)) throw new Error("Invalid project registry.");
    for (const project of projects) {
      if (typeof project?.directory !== "string" || !within(source, await realpath(project.directory))) {
        throw new Error("A registered workspace is outside the data directory; back it up separately before proceeding.");
      }
    }
  }
  for (const path of listing.files.filter(path => path.startsWith("mediaTasks/") && path.endsWith(".json"))) {
    if (pending.has(JSON.parse(await readFile(join(source, path), "utf8")).status)) {
      throw new Error("Unfinished media tasks exist. Reconcile upstream tasks before backing up; do not resubmit them.");
    }
  }
  await mkdir(target, { mode: 0o700 });
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  const files: Entry[] = [];
  for (const path of listing.files) files.push({ path, ...await encrypt(join(source, path), join(target, `${files.length}.bin`), key) });
  const manifest = { version: 1, createdAt: new Date().toISOString(), originalDirectory: source, directories: listing.directories, files };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(manifest)), cipher.final()]);
  await writeAtomic(join(target, "manifest.json"), JSON.stringify({ version: 1, salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: bytes.toString("base64") }), { exclusive: true, mode: 0o600 });
  console.log(`Encrypted backup completed: ${files.length} files. Keep the password separately. External unregistered workspaces are not included.`);
} else {
  const envelope = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  if (envelope.version !== 1 || !/^[a-f0-9]{32}$/.test(envelope.salt) || !/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag)) throw new Error("Invalid backup envelope.");
  const key = scryptSync(password, Buffer.from(envelope.salt, "hex"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  const manifest: Manifest = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) throw new Error("Unsupported manifest.");
  for (const path of [...manifest.directories, ...manifest.files.map(file => file.path)]) {
    if (typeof path !== "string" || path.split("/").some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part)) || !within(target, resolve(target, path))) throw new Error("Unsafe backup path.");
  }
  await mkdir(target, { mode: 0o700 });
  for (const path of manifest.directories) await mkdir(join(target, path), { recursive: true, mode: 0o700 });
  for (const [index, file] of manifest.files.entries()) {
    const input = join(source, `${index}.bin`);
    if (!(await lstat(input)).isFile() || (await lstat(input)).isSymbolicLink()) throw new Error("Invalid encrypted file.");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
    decipher.setAuthTag(Buffer.from(file.tag, "hex"));
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
    await pipeline(createReadStream(input), decipher, meter, createWriteStream(join(target, file.path), { flags: "wx", mode: 0o600 }));
    if (size !== file.size || hash.digest("hex") !== file.hash) throw new Error("Restored file failed integrity verification. Do not start this incomplete directory.");
  }
  console.log(`Restore verified: ${manifest.files.length} files. Original runtime path: ${manifest.originalDirectory}. Keep the same runtime path when mounting; project/task paths are not migrated.`);
}
