import { afterAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeAtomic } from "@toonflow/file";

const script = fileURLToPath(new URL("../scripts/dataBackup.ts", import.meta.url));
const password = randomBytes(24).toString("hex");
const temporaryRoots: string[] = [];

async function createData() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "toonflowBackup")));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const workspace = join(source, "workspaces", "example");
  await mkdir(join(workspace, "empty"), { recursive: true });
  await writeAtomic(join(source, "settings.json"), JSON.stringify({ settings: { language: "zh-CN" } }));
  await writeAtomic(join(source, "projects.json"), JSON.stringify([{ id: crypto.randomUUID(), directory: workspace, name: "备份验证项目", members: [] }]));
  await writeAtomic(join(workspace, "binary.bin"), randomBytes(4096));
  await writeAtomic(join(workspace, "notes.txt"), "仅用于自动验证的合成数据，不是生产备份。\n");
  return { root, source, workspace, backup: join(root, "backup"), restored: join(root, "restored") };
}

async function run(operation: "backup" | "restore", source: string, target: string, suppliedPassword = password) {
  const child = Bun.spawn([process.execPath, script, operation, source, target, "--offline-confirmed"], {
    env: { ...process.env, TOONFLOW_BACKUP_PASSWORD: suppliedPassword },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

afterAll(async () => {
  const temporaryDirectory = await realpath(tmpdir());
  for (const root of temporaryRoots) {
    const actual = await realpath(root);
    if (actual !== root || dirname(actual) !== temporaryDirectory || !basename(actual).startsWith("toonflowBackup")) {
      throw new Error("拒绝清理不属于本次验证的临时目录");
    }
    await rm(actual, { recursive: true });
  }
});

test("备份和恢复真实 CLI 保留文件哈希、空目录及原始项目路径", async () => {
  const data = await createData();
  const backup = await run("backup", data.source, data.backup);
  expect(backup.exitCode).toBe(0);
  expect(backup.stdout).toContain("Encrypted backup completed: 4 files.");
  const restored = await run("restore", data.backup, data.restored);
  expect(restored.exitCode).toBe(0);
  expect(restored.stdout).toContain("Restore verified: 4 files.");
  for (const path of ["settings.json", "projects.json", "workspaces/example/binary.bin", "workspaces/example/notes.txt"]) {
    const originalHash = createHash("sha256").update(await readFile(join(data.source, path))).digest("hex");
    const restoredHash = createHash("sha256").update(await readFile(join(data.restored, path))).digest("hex");
    expect(restoredHash).toBe(originalHash);
  }
  expect(await readdir(join(data.restored, "workspaces", "example", "empty"))).toEqual([]);
  expect(JSON.parse(await readFile(join(data.restored, "projects.json"), "utf8"))[0].directory).toBe(data.workspace);
}, 20000);

test("错误密码恢复失败且不创建恢复目标或输出成功", async () => {
  const data = await createData();
  expect((await run("backup", data.source, data.backup)).exitCode).toBe(0);
  const result = await run("restore", data.backup, data.restored, randomBytes(24).toString("hex"));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.length).toBeGreaterThan(0);
  expect(result.stdout).not.toContain("Restore verified:");
  expect(existsSync(data.restored)).toBe(false);
}, 20000);

test("备份拒绝已有目标并保持原文件不变", async () => {
  const data = await createData();
  await mkdir(data.backup);
  await writeAtomic(join(data.backup, "keep.txt"), "existing backup");
  const result = await run("backup", data.source, data.backup);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).not.toContain("Encrypted backup completed:");
  expect(await readdir(data.backup)).toEqual(["keep.txt"]);
  expect(await readFile(join(data.backup, "keep.txt"), "utf8")).toBe("existing backup");
}, 20000);

test("恢复拒绝已有目标并保持原文件不变", async () => {
  const data = await createData();
  expect((await run("backup", data.source, data.backup)).exitCode).toBe(0);
  await mkdir(data.restored);
  await writeAtomic(join(data.restored, "keep.txt"), "existing data");
  const result = await run("restore", data.backup, data.restored);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).not.toContain("Restore verified:");
  expect(await readdir(data.restored)).toEqual(["keep.txt"]);
  expect(await readFile(join(data.restored, "keep.txt"), "utf8")).toBe("existing data");
}, 20000);

for (const status of ["queued", "running", "saving", "cancelling"]) {
  test(`备份拒绝 ${status} 媒体任务且不修改源记录`, async () => {
    const data = await createData();
    const workspace = process.platform === "win32" ? data.workspace.toLowerCase() : data.workspace;
    const taskDirectory = join(data.source, "mediaTasks", createHash("sha256").update(workspace).digest("hex"));
    await mkdir(taskDirectory, { recursive: true });
    const id = crypto.randomUUID();
    const task = JSON.stringify({ id, mediaType: "video", providerId: "synthetic", modelId: "synthetic", status,
      billingState: "notSubmitted", createdAt: 1, updatedAt: 1, files: [], requestHash: "synthetic" });
    const path = join(taskDirectory, `${id}.json`);
    await writeAtomic(path, task);
    const result = await run("backup", data.source, data.backup);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unfinished media tasks exist.");
    expect(result.stdout).not.toContain("Encrypted backup completed:");
    expect(existsSync(data.backup)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(task);
  }, 20000);
}
