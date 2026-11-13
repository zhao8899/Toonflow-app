import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "@toonflow/file";

const childRoot = process.env.toonflowSubmissionBackupRoot;

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (timedOut || code !== 0) throw new Error(`隔离操作失败（${timedOut ? "超时" : code}）：${stdout}\n${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

async function verifyRoot(root: string) {
  const actual = await realpath(root);
  if (actual !== root || dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith("toonflowSubmissionBackup")) {
    throw new Error("拒绝操作不属于本次验证的临时目录");
  }
}

if (!childRoot) {
  test("真实加密备份恢复保留关闭标记，原挂载路径重启后拒绝迟到提交", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "toonflowSubmissionBackup")));
    const mounted = join(root, "mounted");
    const backup = join(root, "backup");
    const restored = join(root, "restored");
    const original = join(root, "originalData");
    const requestId = crypto.randomUUID();
    const actorId = "backupActor";
    const env = {
      toonflowSubmissionBackupRoot: root, toonflowSubmissionBackupRequestId: requestId,
      toonflowSubmissionBackupActorId: actorId, TOONFLOW_DATA_DIR: mounted,
      TOONFLOW_AUTH_REQUIRED: "false", NODE_ENV: "test",
    };
    try {
      await run(["test", import.meta.path], { ...env, toonflowSubmissionBackupStage: "create" });
      const workspace = join(mounted, "workspaces", "project");
      const normalized = process.platform === "win32" ? workspace.toLowerCase() : workspace;
      const markerPath = join("mediaTasks", createHash("sha256").update(normalized).digest("hex"), `${requestId}.submission.json`);
      const markerBefore = await readFile(join(mounted, markerPath), "utf8");
      expect(JSON.parse(markerBefore).state).toBe("closed");
      const projectBefore = await readFile(join(mounted, "projects.json"), "utf8");
      const script = resolve(import.meta.dirname, "../scripts/dataBackup.ts");
      const backupEnv = { TOONFLOW_BACKUP_PASSWORD: randomBytes(24).toString("hex") };
      expect(await run([script, "backup", mounted, backup, "--offline-confirmed"], backupEnv)).toContain("Encrypted backup completed:");
      expect(await run([script, "restore", backup, restored, "--offline-confirmed"], backupEnv)).toContain("Restore verified:");
      expect(await readFile(join(restored, markerPath), "utf8")).toBe(markerBefore);
      expect(await readFile(join(mounted, markerPath), "utf8")).toBe(markerBefore);
      expect(await readFile(join(restored, "projects.json"), "utf8")).toBe(projectBefore);

      await verifyRoot(root);
      for (const path of [mounted, restored]) {
        if (dirname(await realpath(path)) !== root) throw new Error("拒绝移动临时根目录外的数据");
      }
      if (dirname(resolve(original)) !== root) throw new Error("原始数据保留目录越界");
      await rename(mounted, original);
      await rename(restored, mounted);
      expect(await realpath(mounted)).toBe(mounted);
      await run(["test", import.meta.path], { ...env, toonflowSubmissionBackupStage: "verify" });
      expect(await readFile(join(original, markerPath), "utf8")).toBe(markerBefore);
      expect(await readFile(join(mounted, markerPath), "utf8")).toBe(markerBefore);
      expect(await readFile(join(mounted, "projects.json"), "utf8")).toBe(projectBefore);
    } finally {
      await verifyRoot(root);
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
} else {
  await verifyRoot(childRoot);
  const directory = join(childRoot, "mounted", "workspaces", "project");
  const requestId = process.env.toonflowSubmissionBackupRequestId!;
  const actorId = process.env.toonflowSubmissionBackupActorId!;
  const { registerProject, findProject } = await import("../src/utils/workspace/projects");
  const { resolveMediaSubmission, startMediaTask } = await import("../src/utils/media/tasks");

  test("真实任务入口创建或读取恢复后的关闭标记", async () => {
    if (process.env.toonflowSubmissionBackupStage === "create") {
      await mkdir(directory, { recursive: true });
      const project = registerProject(directory, "关闭标记备份验证", actorId);
      expect(resolveMediaSubmission(directory, requestId, project.id, actorId)).toEqual({ state: "closed", requestId, projectId: project.id, actorId });
      return;
    }
    const project = findProject(directory);
    expect(project).toBeDefined();
    expect(resolveMediaSubmission(directory, requestId, project!.id, actorId)).toEqual({ state: "closed", requestId, projectId: project!.id, actorId });
    let executions = 0;
    let failure: unknown;
    try {
      const operation = startMediaTask(directory, "video", { providerId: "localTest", modelId: "video", prompt: "迟到提交不得执行" }, async () => {
        executions++;
        return [];
      }, requestId, undefined, { id: actorId, username: actorId, member: false });
      await operation.completion;
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 409 });
    expect((failure as Error).message).toContain("已关闭");
    expect(executions).toBe(0);
  });
}
