import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "@toonflow/file";

const childRoot = process.env.toonflowCancellationTestRoot;
if (!childRoot) {
  test("独立进程验证取消与存储故障，不污染配置单例", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "toonflowCancellation"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, toonflowCancellationTestRoot: temporaryRoot, TOONFLOW_DATA_DIR: join(temporaryRoot, "data") },
        stdout: "inherit", stderr: "inherit",
      });
      timeout = setTimeout(() => child?.kill(), 30000);
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timeout);
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      if (!resolve(temporaryRoot).startsWith(`${resolve(tmpdir())}${sep}toonflowCancellation`)) throw new Error("临时目录越界");
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 45000);
} else {
  const temporaryRoot = childRoot;
  if (!resolve(temporaryRoot).startsWith(`${resolve(tmpdir())}${sep}toonflowCancellation`)) throw new Error("临时目录越界");
  const { startMediaTask, cancelMediaTask, getMediaTask } = await import("../src/utils/media/tasks");
  const request = { providerId: "localTest", modelId: "video", prompt: "cancellation regression" };

  async function startWaiting() {
    const directory = mkdtempSync(join(temporaryRoot, "workspace"));
    const started = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<never>();
    const operation = startMediaTask(directory, "video", request, async (signal, progress) => {
      progress("running");
      signal.addEventListener("abort", () => stopped.reject(signal.reason), { once: true });
      started.resolve(signal);
      return stopped.promise;
    });
    const signal = await started.promise;
    const normalized = process.platform === "win32" ? directory.toLowerCase() : directory;
    const records = join(temporaryRoot, "data", "mediaTasks", createHash("sha256").update(normalized).digest("hex"));
    return { ...operation, directory, signal, records };
  }

  function blockWrites(records: string) {
    renameSync(records, `${records}Saved`);
    writeFileSync(records, "阻止任务快照写入：临时测试数据", { flag: "wx" });
    return () => {
      rmSync(records);
      renameSync(`${records}Saved`, records);
    };
  }

  for (const cancelBeforeStart of [true, false]) {
    test(`外部信号${cancelBeforeStart ? "启动前已取消" : "排队期间取消"}不执行生成`, async () => {
      const directory = mkdtempSync(join(temporaryRoot, "workspace"));
      const controller = new AbortController();
      let executions = 0;
      const execute = async () => {
        executions++;
        return [];
      };
      if (cancelBeforeStart) {
        const id = crypto.randomUUID();
        const reason = new Error("提交前连接已关闭");
        controller.abort(reason);
        expect(() => startMediaTask(directory, "video", request, execute, id, controller.signal)).toThrow(reason);
        expect(executions).toBe(0);
        expect(() => getMediaTask(directory, id)).toThrow("生成任务不存在");
        return;
      }
      const operation = startMediaTask(directory, "video", request, execute, undefined, controller.signal);
      controller.abort();
      const completed = await operation.completion;
      expect(executions).toBe(0);
      expect(completed.status).toBe("cancelled");
      expect(completed.billingState).toBe("notSubmitted");
      const persisted = getMediaTask(directory, operation.task.id);
      expect(persisted.status).toBe("cancelled");
      expect(persisted.billingState).toBe("notSubmitted");
      expect(persisted.files).toEqual([]);
    });
  }

  test("正常取消停止执行，保留费用不确定状态，重复取消不改终态", async () => {
    const operation = await startWaiting();
    expect(cancelMediaTask(operation.directory, operation.task.id).status).toBe("cancelling");
    expect(operation.signal.aborted).toBe(true);
    const completed = await operation.completion;
    expect(completed.status).toBe("cancelled");
    expect(completed.billingState).toBe("unknown");
    const { exportActivity } = await import("../src/utils/activity");
    const events = exportActivity(new Date().toISOString().slice(0, 10)).filter(event => event.taskId === operation.task.id);
    expect(events.some(event => event.stage === "cancellationObserved")).toBe(true);
    expect(events.filter(event => event.stage === "statusChanged").map(event => event.status)).toEqual(["queued", "running", "cancelling", "cancelled"]);
    const before = readFileSync(join(operation.records, `${operation.task.id}.json`), "utf8");
    expect(cancelMediaTask(operation.directory, operation.task.id).status).toBe("cancelled");
    expect(readFileSync(join(operation.records, `${operation.task.id}.json`), "utf8")).toBe(before);
  });

  test("取消快照写入失败仍发送 abort，同时向调用方抛出存储错误", async () => {
    const operation = await startWaiting();
    const restore = blockWrites(operation.records);
    let aborted = false;
    try {
      expect(() => cancelMediaTask(operation.directory, operation.task.id)).toThrow();
      aborted = operation.signal.aborted;
    } finally {
      restore();
      if (!operation.signal.aborted) cancelMediaTask(operation.directory, operation.task.id);
    }
    const completed = await operation.completion;
    expect(aborted).toBe(true);
    const { exportActivity } = await import("../src/utils/activity");
    expect(exportActivity(new Date().toISOString().slice(0, 10)).some(event => event.taskId === operation.task.id && event.stage === "persistenceFailed")).toBe(true);
    expect(completed.status).toBe("cancelled");
    expect(getMediaTask(operation.directory, operation.task.id).status).toBe("cancelled");
  });

  test("存储持续不可写时取消仍停止执行，完成 Promise 拒绝而非伪报成功", async () => {
    const operation = await startWaiting();
    const restore = blockWrites(operation.records);
    let aborted = false;
    try {
      expect(() => cancelMediaTask(operation.directory, operation.task.id)).toThrow();
      aborted = operation.signal.aborted;
      if (aborted) await expect(operation.completion).rejects.toThrow("任务记录保存失败");
    } finally {
      restore();
      if (!operation.signal.aborted) {
        cancelMediaTask(operation.directory, operation.task.id);
        await operation.completion;
      }
    }
    expect(aborted).toBe(true);
  });

  test("结束后的旧进度回调不改写终态，也不能干扰同ID续查", async () => {
    const { resumeMediaTask } = await import("../src/utils/media/tasks");
    const directory = mkdtempSync(join(temporaryRoot, "lateProgress"));
    const normalized = process.platform === "win32" ? directory.toLowerCase() : directory;
    const records = join(temporaryRoot, "data", "mediaTasks", createHash("sha256").update(normalized).digest("hex"));
    let oldProgress!: Parameters<Parameters<typeof startMediaTask>[3]>[1];
    const hash = "a".repeat(64);
    const operation = startMediaTask(directory, "video", request, async (_signal, progress) => {
      oldProgress = progress;
      progress("running", undefined, "originalUpstream", hash);
      throw new Error("controlled interruption");
    });
    expect((await operation.completion).status).toBe("failed");
    const path = join(records, `${operation.task.id}.json`);
    const before = readFileSync(path, "utf8");
    oldProgress("saving", [], "lateUpstream", hash);
    expect(readFileSync(path, "utf8")).toBe(before);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let newProgress!: typeof oldProgress;
    const resumed = resumeMediaTask(directory, operation.task.id, hash, async (_signal, progress) => {
      newProgress = progress;
      progress("running");
      entered.resolve();
      await release.promise;
      return [];
    });
    try {
      await entered.promise;
      const running = readFileSync(path, "utf8");
      oldProgress("saving", [], "staleAttempt", hash);
      expect(readFileSync(path, "utf8")).toBe(running);
      expect(getMediaTask(directory, operation.task.id).providerTaskId).toBe("originalUpstream");
    } finally { release.resolve(); await resumed.completion; }
    expect(getMediaTask(directory, operation.task.id).status).toBe("succeeded");
    const completed = readFileSync(path, "utf8");
    newProgress("running", undefined, "lateSuccess", hash);
    expect(readFileSync(path, "utf8")).toBe(completed);
    expect(getMediaTask(directory, operation.task.id).status).toBe("succeeded");
  });

  test("取消中的当前回调仍保留上游ID，取消结束后忽略迟到进度", async () => {
    const directory = mkdtempSync(join(temporaryRoot, "cancellingProgress"));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let report!: Parameters<Parameters<typeof startMediaTask>[3]>[1];
    const operation = startMediaTask(directory, "video", request, async (signal, progress) => {
      report = progress;
      progress("running"); entered.resolve();
      await release.promise;
      signal.throwIfAborted();
      return [];
    });
    try {
      await entered.promise;
      cancelMediaTask(directory, operation.task.id);
      report("running", undefined, "receivedDuringCancel", "a".repeat(64));
      expect(getMediaTask(directory, operation.task.id)).toMatchObject({ status: "cancelling", providerTaskId: "receivedDuringCancel", billingState: "unknown" });
    } finally { release.resolve(); await operation.completion; }
    const before = getMediaTask(directory, operation.task.id);
    expect(before.status).toBe("cancelled");
    report("saving", [], "lateCancelled", "b".repeat(64));
    expect(getMediaTask(directory, operation.task.id)).toEqual(before);
  });

  test("已成功任务不受取消影响", async () => {
    const directory = join(temporaryRoot, "completedWorkspace");
    mkdirSync(directory);
    const operation = startMediaTask(directory, "video", request, async (_signal, progress) => {
      progress("running");
      progress("running", undefined, "upstreamOne");
      progress("running", undefined, "upstreamOne");
      progress("saving");
      return [];
    });
    await operation.completion;
    expect(cancelMediaTask(directory, operation.task.id).status).toBe("succeeded");
    let executions = 0;
    await startMediaTask(directory, "video", request, async () => { executions++; return []; }, operation.task.id).completion;
    const { exportActivity, getActivityStatus } = await import("../src/utils/activity");
    const events = exportActivity(new Date().toISOString().slice(0, 10)).filter(event => event.taskId === operation.task.id);
    expect(events.filter(event => event.stage === "statusChanged").map(event => event.status)).toEqual(["queued", "running", "saving", "succeeded"]);
    expect(events.filter(event => event.stage === "providerTaskReceived")).toHaveLength(1);
    expect(events.filter(event => event.stage === "submissionReused")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(request.prompt);
    expect(executions).toBe(0);
    const previousLimit = process.env.TOONFLOW_ACTIVITY_MAX_FILES;
    const before = getActivityStatus();
    try {
      process.env.TOONFLOW_ACTIVITY_MAX_FILES = "1";
      const blocked = startMediaTask(directory, "video", request, async () => { executions++; return []; });
      expect((await blocked.completion).status).toBe("succeeded");
      expect(executions).toBe(1);
      expect(getActivityStatus().rejected).toBeGreaterThan(before.rejected);
      expect(getActivityStatus().files).toBe(before.files);
    } finally {
      if (previousLimit === undefined) delete process.env.TOONFLOW_ACTIVITY_MAX_FILES;
      else process.env.TOONFLOW_ACTIVITY_MAX_FILES = previousLimit;
    }
  });
}
