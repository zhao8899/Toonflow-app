import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeAtomicSync, writeFile } from "@toonflow/file";
import * as file from "@toonflow/file";

const childRoot = process.env.toonflowActivityTestRoot;
const scenario = process.env.toonflowActivityScenario;
if (!childRoot) {
  for (const name of ["limits", "storage", "scan", "rescan", "write", "restart", "http", "local", "query"]) test(`日志容量：${name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "toonflowActivity"));
    const logs = join(root, "data", "activity", "2026-01-01");
    mkdirSync(logs, { recursive: true });
    writeAtomicSync(join(logs, "1existing.json"), "older", { exclusive: true });
    try {
      for (let run = 1; run <= (name === "restart" ? 2 : 1); run++) {
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          cwd: resolve(import.meta.dirname, ".."),
          env: { ...process.env, toonflowActivityTestRoot: root, toonflowActivityScenario: name, toonflowActivityRun: String(run),
            TOONFLOW_DATA_DIR: join(root, "data"), TOONFLOW_AUTH_REQUIRED: name === "http" ? "true" : "false", NODE_ENV: "test",
            TOONFLOW_ADMIN_USERNAME: "activityAdmin", TOONFLOW_ADMIN_PASSWORD: "temporaryCapacityPassword",
            TOONFLOW_ACTIVITY_MAX_BYTES: "268435456", TOONFLOW_ACTIVITY_MAX_FILES: "100000", TOONFLOW_ACTIVITY_MAX_RECORD_BYTES: "262144", TOONFLOW_ACTIVITY_MIN_FREE_BYTES: "1" },
          stdout: "pipe", stderr: "pipe",
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), name === "query" ? 60000 : 30000);
        try {
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (code !== 0) throw new Error(`${name} 子进程失败\n${stdout}\n${stderr}`);
          expect(code).toBe(0);
          if (name === "limits" || name === "http") expect((stderr.match(/操作日志写入已拒绝/g) ?? []).length).toBe(1);
          if (name === "rescan") expect((stderr.match(/操作日志写入已拒绝/g) ?? []).length).toBe(2);
          expect(stderr).not.toContain(root);
          console.info(`${name} 第 ${run} 次：\n${stderr.trim().split("\n").slice(-4).join("\n")}`);
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) child.kill("SIGKILL");
          await child.exited;
        }
      }
      expect(readFileSync(join(logs, "1existing.json"), "utf8")).toBe("older");
    } finally {
      if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}toonflowActivity`)) throw new Error("临时目录越界");
      rmSync(root, { recursive: true, force: true });
    }
  }, 70000);
} else {
  if (!resolve(childRoot).startsWith(`${resolve(tmpdir())}${sep}toonflowActivity`)) throw new Error("临时目录越界");
  const { getActivityStatus, recordActivity } = await import("../src/utils/activity");
  if (scenario === "query") test("跨天扫描真实文件数量、结果上限、取消与超时，扫描期间事件循环可响应", async () => {
    const { findTaskActivity } = await import("../src/utils/activity");
    const taskId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    for (const [day, count, id] of [["2026-03-01", 10001, otherId], ["2026-03-02", 2001, taskId]] as const) {
      const directory = join(childRoot, "data", "activity", day); mkdirSync(directory);
      for (let offset = 0; offset < count; offset += 64) {
        await Promise.all(Array.from({ length: Math.min(64, count - offset) }, (_, index) => writeFile(join(directory, `${offset + index}aaaa.json`),
          JSON.stringify({ kind: "mediaTask", taskId: id, recordedAt: offset + index, stage: "statusChanged", status: "running" }), { flag: "wx" })));
      }
    }
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    try {
      const files = await findTaskActivity("2026-03-01", "2026-03-01", taskId);
      expect(files.scannedFiles).toBe(10000);
      expect(files.limitReached).toBe(true);
      expect(files.timedOut).toBe(false);
      expect(files.incomplete).toBe(true);
      expect(files.events).toHaveLength(0);
      expect(files.unscannedDays).toEqual(["2026-03-01"]);
      expect(ticks).toBeGreaterThan(1);
      const results = await findTaskActivity("2026-03-02", "2026-03-02", taskId);
      expect(results.events).toHaveLength(2000);
      expect(results.scannedFiles).toBe(2000);
      expect(results.limitReached).toBe(true);
      expect(results.incomplete).toBe(true);
      expect(results.events.map(event => event.recordedAt)).toEqual(results.events.map(event => event.recordedAt).sort((a, b) => Number(a) - Number(b)));
      const { createApp } = await import("../src/app");
      const app = await createApp({ dataDirectory: join(childRoot, "data"), webRoot: join(childRoot, "web") });
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无端口");
      const origin = `http://127.0.0.1:${address.port}`;
      const headers = { origin, "x-toonflow-workspace": "1" };
      const started = Promise.withResolvers<AbortSignal>();
      const originalHttpRead = file.readFile;
      let httpReads = 0;
      const httpObserved = spyOn(file, "readFile").mockImplementation((async (...args: Parameters<typeof originalHttpRead>) => {
        const options = args[1] as { signal?: AbortSignal };
        if (options?.signal) { httpReads++; started.resolve(options.signal); }
        return (originalHttpRead as any)(...args);
      }) as typeof originalHttpRead);
      try {
        expect((await fetch(`${origin}/api/activity/status`, { headers })).status).toBe(200);
        const beforeStatus = getActivityStatus();
        const stop = new AbortController();
        let finished = false;
        const pending = fetch(`${origin}/api/activity/export?startDay=2026-03-01&endDay=2026-03-01&taskId=${taskId}`, { headers, signal: stop.signal }).then(
          () => { finished = true; return "completed"; }, () => { finished = true; return "cancelled"; });
        const serverSignal = await started.promise;
        expect((await fetch(`${origin}/api/activity/status`, { headers })).status).toBe(200);
        expect(finished).toBe(false);
        const aborted = new Promise<void>(resolve => serverSignal.addEventListener("abort", () => resolve(), { once: true }));
        stop.abort();
        expect(await pending).toBe("cancelled");
        await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("服务端未取消")), 2000))]);
        const afterAbort = httpReads;
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(httpReads).toBe(afterAbort);
        expect(getActivityStatus().files).toBe(beforeStatus.files);
      } finally {
        httpObserved.mockRestore(); server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      const controller = new AbortController();
      const original = file.readFile;
      let reads = 0;
      const observed = spyOn(file, "readFile").mockImplementation((async (...args: Parameters<typeof original>) => {
        reads++;
        const value = await (original as any)(...args);
        controller.abort(new Error("查询已取消"));
        return value;
      }) as typeof original);
      try {
        await expect(findTaskActivity("2026-03-01", "2026-03-02", taskId, controller.signal)).rejects.toThrow("查询已取消");
        expect(reads).toBe(1);
      } finally { observed.mockRestore(); }
      const waitingController = new AbortController();
      const originalOpen = file.opendir;
      let closed = 0;
      const cancelledOpen = spyOn(file, "opendir").mockImplementation((async (...args: Parameters<typeof originalOpen>) => {
        const directory = await originalOpen(...args);
        const close = directory.close.bind(directory);
        directory.close = (async () => { closed++; await close(); }) as typeof directory.close;
        waitingController.abort(new Error("目录等待时取消"));
        return directory;
      }) as typeof originalOpen);
      try {
        await expect(findTaskActivity("2026-03-01", "2026-03-01", taskId, waitingController.signal)).rejects.toThrow("目录等待时取消");
        expect(closed).toBe(1);
      } finally { cancelledOpen.mockRestore(); }
      const originalRead = file.readFile;
      const delayed = spyOn(file, "readFile").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
        await new Promise(resolve => setTimeout(resolve, 10050));
        return (originalRead as any)(...args);
      }) as typeof originalRead);
      try {
        const timeout = await findTaskActivity("2026-03-01", "2026-03-02", taskId);
        expect(timeout.timedOut).toBe(true);
        expect(timeout.incomplete).toBe(true);
        expect(timeout.unscannedDays).toEqual(["2026-03-01", "2026-03-02"]);
        expect(timeout.invalidFiles).toBe(0);
      } finally { delayed.mockRestore(); }
      // 再查可正常打开原目录，验证提前退出没有遗留句柄/协调锁。
      expect((await findTaskActivity("2026-03-02", "2026-03-02", taskId)).events).toHaveLength(2000);
    } finally { clearInterval(heartbeat); }
  }, 55000);
  if (scenario === "limits") test("字节、文件数、单条、磁盘和非法配置拒绝且可恢复，不重写旧日志", () => {
    expect(getActivityStatus().files).toBe(1);
    expect(getActivityStatus().bytes).toBe(5);
    process.env.TOONFLOW_ACTIVITY_MAX_RECORD_BYTES = "1";
    expect(() => recordActivity({ kind: "tooLarge" })).toThrow();
    expect(getActivityStatus().files).toBe(1);
    process.env.TOONFLOW_ACTIVITY_MAX_RECORD_BYTES = "262144";
    recordActivity({ kind: "accepted" });
    expect(getActivityStatus().files).toBe(2);
    process.env.TOONFLOW_ACTIVITY_MAX_FILES = "2";
    expect(() => recordActivity({ kind: "fileLimit" })).toThrow();
    expect(getActivityStatus().blocked).toBe(true);
    process.env.TOONFLOW_ACTIVITY_MAX_FILES = "100000";
    process.env.TOONFLOW_ACTIVITY_MAX_BYTES = String(getActivityStatus().bytes + 1);
    expect(() => recordActivity({ kind: "byteLimit" })).toThrow();
    process.env.TOONFLOW_ACTIVITY_MAX_BYTES = "268435456";
    process.env.TOONFLOW_ACTIVITY_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    expect(() => recordActivity({ kind: "diskLimit" })).toThrow();
    expect(getActivityStatus().blocked).toBe(true);
    process.env.TOONFLOW_ACTIVITY_MIN_FREE_BYTES = "1";
    recordActivity({ kind: "recovered" });
    expect(getActivityStatus().blocked).toBe(false);
    expect(getActivityStatus().files).toBe(3);
    process.env.TOONFLOW_ACTIVITY_MAX_FILES = "0";
    expect(() => recordActivity({ kind: "badConfig" })).toThrow();
    expect(getActivityStatus().blocked).toBe(true);
    expect(getActivityStatus().rejected).toBe(5);
    expect(JSON.stringify(getActivityStatus())).not.toContain(childRoot);
  });
  if (scenario === "storage") test("磁盘查询失败关闭日志，不缓存为零容量", () => {
    expect(getActivityStatus().files).toBe(1);
    const data = join(childRoot, "data"), moved = join(childRoot, "dataMoved");
    renameSync(data, moved);
    try {
      expect(getActivityStatus().blocked).toBe(true);
      expect(() => recordActivity({ kind: "unavailable" })).toThrow();
      expect(getActivityStatus().files).toBe(1);
    } finally { renameSync(moved, data); }
    expect(getActivityStatus().blocked).toBe(false);
  });
  if (scenario === "restart") test("新进程扫描已有容量，拒绝计数从零开始", () => {
    const run = Number(process.env.toonflowActivityRun);
    expect(getActivityStatus().files).toBe(run);
    expect(getActivityStatus().rejected).toBe(0);
    recordActivity({ kind: "restartEvidence" });
    expect(getActivityStatus().files).toBe(run + 1);
  });
  if (scenario === "scan") test("初始扫描失败不当作空目录，也不泄露原始路径", () => {
    const root = join(childRoot, "data", "activity"), moved = join(childRoot, "data", "activitySaved");
    renameSync(root, moved);
    writeAtomicSync(root, "invalid directory", { exclusive: true });
    try {
      const status = getActivityStatus();
      expect(status.blocked).toBe(true);
      expect(status.lastScannedAt).toBeNull();
      expect(status.reason).toBe("日志容量扫描失败或存在不安全链接，已停止新增日志");
      expect(JSON.stringify(status)).not.toContain(childRoot);
      expect(() => recordActivity({ kind: "scanFailure" })).toThrow();
      expect(getActivityStatus().rejected).toBe(1);
    } finally { rmSync(root); renameSync(moved, root); }
  });
  if (scenario === "rescan") test("周期重扫外部增删并恢复；告警按窗口累计，不重放丢失日志", () => {
    const startedAt = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(startedAt);
    const external = join(childRoot, "data", "activity", "2026-01-01", "2external.json");
    try {
      expect(getActivityStatus().files).toBe(1);
      writeAtomicSync(external, "{}", { exclusive: true });
      expect(getActivityStatus().files).toBe(1);
      clock.mockReturnValue(startedAt + 60001);
      expect(getActivityStatus().files).toBe(2);
      expect(getActivityStatus().bytes).toBe(7);
      process.env.TOONFLOW_ACTIVITY_MAX_FILES = "2";
      expect(() => recordActivity({ kind: "full" })).toThrow();
      expect(() => recordActivity({ kind: "fullAgain" })).toThrow();
      rmSync(external);
      expect(getActivityStatus().blocked).toBe(true);
      clock.mockReturnValue(startedAt + 120002);
      expect(getActivityStatus().blocked).toBe(false);
      expect(getActivityStatus().files).toBe(1);
      recordActivity({ kind: "recovered" });
      expect(getActivityStatus().rejected).toBe(2);
      expect(() => recordActivity({ kind: "fullNextWindow" })).toThrow();
      expect(getActivityStatus().rejected).toBe(3);
    } finally { clock.mockRestore(); }
  });
  if (scenario === "write") test("原子写入冲突不覆盖旧日志、不增加成功计数，后续可恢复", () => {
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    const id = "00000000-0000-4000-8000-000000000001";
    const random = spyOn(crypto, "randomUUID").mockReturnValue(id);
    try {
      recordActivity({ kind: "first" });
      const original = join(childRoot, "data", "activity", new Date(Date.now()).toISOString().slice(0, 10), `${Date.now()}${id}.json`);
      const content = readFileSync(original, "utf8");
      const bytes = getActivityStatus().bytes;
      expect(() => recordActivity({ kind: "collision" })).toThrow();
      expect(readFileSync(original, "utf8")).toBe(content);
      expect(getActivityStatus().files).toBe(2);
      expect(getActivityStatus().bytes).toBe(bytes);
      expect(getActivityStatus().blocked).toBe(true);
      random.mockRestore();
      recordActivity({ kind: "recovered" });
      expect(getActivityStatus().blocked).toBe(false);
      expect(getActivityStatus().files).toBe(3);
      expect(getActivityStatus().rejected).toBe(1);
    } finally { random.mockRestore(); clock.mockRestore(); }
  });
  if (scenario === "http" || scenario === "local") test("容量已满不破坏HTTP业务，状态沿用管理员或可信本地模式且不自记录", async () => {
    process.env.TOONFLOW_ACTIVITY_MAX_FILES = "1";
    const { createApp } = await import("../src/app");
    const app = await createApp({ dataDirectory: join(childRoot, "data"), webRoot: join(childRoot, "web") });
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("未取得端口");
      const origin = `http://127.0.0.1:${address.port}`;
      const request = (path: string, cookie = "", method = "GET", body?: unknown) => fetch(`${origin}/api/${path}`, {
        method, headers: { origin, cookie, "x-toonflow-workspace": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (scenario === "local") {
        const first = await request("activity/status");
        expect(first.status).toBe(200);
        expect((await first.json()).data.blocked).toBe(true);
        expect((await request("settings/get")).status).toBe(200);
        return;
      }
      expect((await request("activity/status")).status).toBe(401);
      const adminLogin = await request("auth/login", "", "POST", { username: "activityAdmin", password: "temporaryCapacityPassword" });
      expect(adminLogin.status).toBe(200);
      const admin = adminLogin.headers.get("set-cookie")!.split(";")[0]!;
      expect((await request("users/create", admin, "POST", { username: "capacityMember", password: "temporaryMemberPassword", role: "user" })).status).toBe(201);
      const memberLogin = await request("auth/login", "", "POST", { username: "capacityMember", password: "temporaryMemberPassword" });
      expect(memberLogin.status).toBe(200);
      const member = memberLogin.headers.get("set-cookie")!.split(";")[0]!;
      expect((await request("activity/status", member)).status).toBe(403);
      const first = await request("activity/status", admin);
      expect(first.status).toBe(200);
      const status = (await first.json()).data;
      expect(status.blocked).toBe(true);
      expect(status.files).toBe(1);
      const second = (await (await request("activity/status", admin)).json()).data;
      expect(second.rejected).toBe(status.rejected);
      expect(JSON.stringify(second)).not.toContain(childRoot);
      expect((await request("settings/get", admin)).status).toBe(200);
      const workspace = join(childRoot, "data", "workspaces", "logging");
      mkdirSync(workspace, { recursive: true });
      for (let index = 0; index < 3; index++) {
        const explicit = await request("ai/media/tasks/activity", admin, "POST", { directory: workspace, action: "promptApplied", prompt: "local" });
        expect(explicit.status).toBe(503);
        expect((await explicit.json()).message).toContain("未保存");
      }
      const beforePost = (await (await request("activity/status", admin)).json()).data.rejected;
      expect((await request("activity/status", admin, "POST", {})).status).toBe(404);
      const afterPost = (await (await request("activity/status", admin)).json()).data.rejected;
      expect(afterPost).toBe(beforePost + 1);
      const day = "2026-02-02", taskId = crypto.randomUUID();
      const directory = join(childRoot, "data", "activity", day);
      mkdirSync(directory, { recursive: true });
      writeAtomicSync(join(directory, "1aaaa.json"), JSON.stringify({ kind: "mediaTask", taskId, recordedAt: 2, stage: "executionFailed", status: "running", prompt: "privatePrompt", error: "privateError" }));
      writeAtomicSync(join(directory, "2bbbb.json"), JSON.stringify({ kind: "http", taskId, recordedAt: 1, status: 202, details: { prompt: "privatePrompt" } }));
      writeAtomicSync(join(directory, "3cccc.json"), JSON.stringify({ kind: "mediaTask", taskId: crypto.randomUUID(), recordedAt: 3, stage: "recoveryStarted" }));
      const query = `activity/export?day=${day}&taskId=${taskId.toUpperCase()}`;
      expect((await request(query)).status).toBe(401);
      expect((await request(query, member)).status).toBe(403);
      const result = await request(query, admin);
      expect(result.status).toBe(200);
      const events = (await result.json()).data.events;
      expect(events.map((event: any) => event.recordedAt)).toEqual([1, 2]);
      expect(JSON.stringify(events)).not.toContain("private");
      expect((await request(`activity/export?day=${day}&taskId=invalid`, admin)).status).toBe(400);
      expect((await (await request(`activity/export?day=${day}&taskId=${crypto.randomUUID()}`, admin)).json()).data.events).toEqual([]);
      const nextDay = join(childRoot, "data", "activity", "2026-02-03");
      mkdirSync(nextDay);
      writeAtomicSync(join(nextDay, "1aaaa.json"), JSON.stringify({ kind: "mediaTask", taskId, recordedAt: 4, stage: "recoveryStarted" }));
      writeAtomicSync(join(nextDay, "2bbbb.json"), "broken-private-content");
      const range = `activity/export?startDay=${day}&endDay=2026-02-04&taskId=${taskId}`;
      expect((await request(range, member)).status).toBe(403);
      const crossDay = (await (await request(range, admin)).json()).data;
      expect(crossDay.events.map((event: any) => event.recordedAt)).toEqual([1, 2, 4]);
      expect(crossDay.incomplete).toBe(true);
      expect(crossDay.invalidFiles).toBe(1);
      expect(crossDay.missingDays).toEqual(["2026-02-04"]);
      expect(JSON.stringify(crossDay)).not.toContain("private");
      expect(readFileSync(join(nextDay, "2bbbb.json"), "utf8")).toBe("broken-private-content");
      for (const params of ["startDay=2026-02-03&endDay=2026-02-02", "startDay=2026-02-01&endDay=2026-02-08", "startDay=2026-02-01", "day=2026-02-02&startDay=2026-02-01&endDay=2026-02-02"]) {
        expect((await request(`activity/export?${params}&taskId=${taskId}`, admin)).status).toBe(400);
      }
      writeAtomicSync(join(nextDay, "3cccc.json"), "x".repeat(20 * 1024 * 1024));
      const limited = (await (await request(range, admin)).json()).data;
      expect(limited.limitReached).toBe(true);
      expect(limited.unscannedDays).toEqual(["2026-02-03", "2026-02-04"]);
      expect(limited.scannedBytes).toBeLessThan(20 * 1024 * 1024);
      expect(limited.events.length).toBeGreaterThanOrEqual(2);
      expect(limited.events.length).toBeLessThanOrEqual(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
