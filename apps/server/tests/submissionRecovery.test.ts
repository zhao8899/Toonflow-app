import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, renameSync, rmSync, withFileAccess, writeAtomicSync } from "@toonflow/file";

const childRoot = process.env.toonflowSubmissionTestRoot;
const scenario = process.env.toonflowSubmissionScenario;
if (!childRoot) {
  for (const name of ["core", "restart", "recoveryRestart", "forcedTermination", "http", "resume"]) test(`提交恢复：${name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "toonflowSubmission"));
    try {
      for (let run = 1; run <= (["recoveryRestart", "forcedTermination"].includes(name) ? 4 : name === "restart" ? 2 : 1); run++) {
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          cwd: resolve(import.meta.dirname, ".."),
          env: { ...process.env, toonflowSubmissionTestRoot: root, toonflowSubmissionScenario: name, toonflowSubmissionRun: String(run),
            TOONFLOW_DATA_DIR: join(root, "data"), NODE_ENV: "test", TOONFLOW_AUTH_REQUIRED: name === "http" ? "true" : "false",
            TOONFLOW_ADMIN_USERNAME: "recoveryAdmin", TOONFLOW_ADMIN_PASSWORD: "temporaryRecoveryPassword" },
          stdout: "pipe", stderr: "pipe",
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
        try {
          if (name === "forcedTermination" && run < 3) {
            const workspace = join(root, "data", "workspaces", "forcedTermination");
            let observed = false;
            for (let poll = 0; poll < 10000 && child.exitCode === null; poll++) {
              if (run === 1) observed = existsSync(join(workspace, "ready.json"));
              else if (existsSync(workspace)) {
                for (const file of readdirSync(workspace).filter(file => file.startsWith(".write-"))) {
                  try { const size = statSync(join(workspace, file)).size; observed = size > 0; }
                  catch { continue; }
                  if (observed) break;
                }
              }
              if (observed) { child.kill("SIGKILL"); break; }
              await Bun.sleep(1);
            }
            expect(observed).toBe(true);
            const code = await child.exited;
            expect(code).not.toBe(0);
            const files = readdirSync(workspace).filter(file => file.startsWith(".write-")).map(file => ({ file, size: statSync(join(workspace, file)).size }));
            console.info("强制终止证据", JSON.stringify({ run, code, root, files }));
            if (run === 2) {
              expect(files.length).toBeGreaterThan(0);
              expect(files.some(file => file.size > 0)).toBe(true);
              expect(existsSync(join(workspace, "result.mp4"))).toBe(false);
            }
            continue;
          }
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (code !== 0) throw new Error(`${name} 子进程失败\n${stdout}\n${stderr}`);
          expect(code).toBe(0);
          console.info(`${name} 第 ${run} 次：\n${stderr.trim().split("\n").slice(-4).join("\n")}`);
        } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
      }
    } finally {
      if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}toonflowSubmission`)) throw new Error("临时目录越界");
      if (name === "forcedTermination") console.info("保留强制终止验收数据", root);
      else rmSync(root, { recursive: true, force: true });
    }
  }, 70000);
} else {
  if (!resolve(childRoot).startsWith(`${resolve(tmpdir())}${sep}toonflowSubmission`)) throw new Error("临时目录越界");
  const { resolveMediaSubmission, startMediaTask, listMediaTasks, getMemberGenerationQuota } = await import("../src/utils/media/tasks");
  const { registerProject } = await import("../src/utils/workspace/projects");
  const actor = { id: "actorOne", username: "memberOne", member: false };
  const request = { providerId: "localTest", modelId: "video", prompt: "local concurrency regression" };
  function createProject(name: string) {
    const directory = join(childRoot, "data", "workspaces", name);
    mkdirSync(directory, { recursive: true });
    const project = registerProject(directory, name, actor.id);
    const normalized = process.platform === "win32" ? directory.toLowerCase() : directory;
    const records = join(childRoot, "data", "mediaTasks", createHash("sha256").update(normalized).digest("hex"));
    return { directory, project, records };
  }
  if (scenario === "resume") test("同ID续查仅GET，配置改变/并发/不支持不改原任务", async () => {
    const { addMediaProvider } = await import("../src/utils/media/provider");
    const { resumeMediaGeneration } = await import("../src/utils/media/generation");
    const { getMediaTask } = await import("../src/utils/media/tasks");
    const { default: conf } = await import("../src/utils/conf");
    const methods: string[] = [];
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      methods.push(req.method); entered.resolve(); await release.promise;
      return Response.json([{ type: "base64", mediaType: "video", mimeType: "video/mp4", data: "AAAAGGZ0eXBpc29tAAACAGlzb21pc28y" }]);
    } });
    const { directory, project, records } = createProject("resume");
    const configHash = createHash("sha256").update("{}").digest("hex");
    try {
      await addMediaProvider(`export default { id: "resumeLocal", label: "Local", rules: [], models: [{id:"video",label:"Video",type:"video"}],
        async generateVideo() { throw new Error("Must not generate"); },
        async resumeVideo(id) { const response = await this.tool.fetch("http://127.0.0.1:${upstream.port}/" + id); return response.json(); } };`);
      const id = crypto.randomUUID();
      await startMediaTask(directory, "video", { ...request, providerId: "resumeLocal" }, async (_signal, progress) => {
        progress("running", undefined, "upstreamOne", configHash); throw new Error("local interruption");
      }, id, undefined, actor).completion;
      const path = join(records, `${id}.json`), before = readFileSync(path, "utf8");
      conf.set("settings.mediaProviderConfigs.resumeLocal", { changed: true });
      await expect(resumeMediaGeneration(directory, id)).rejects.toThrow("供应商配置已改变");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(methods).toEqual([]);
      conf.delete("settings.mediaProviderConfigs.resumeLocal");
      mkdirSync(join(directory, "assets"));
      const occupiedOutput = join(directory, "assets", "generated");
      writeAtomicSync(occupiedOutput, "keep existing output conflict");
      await expect(resumeMediaGeneration(directory, id)).rejects.toThrow("输出目录已被文件占用");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readFileSync(occupiedOutput, "utf8")).toBe("keep existing output conflict");
      expect(methods).toEqual([]);
      renameSync(occupiedOutput, join(directory, "retainedConflict"));
      const attempts = await Promise.allSettled([resumeMediaGeneration(directory, id), resumeMediaGeneration(directory, id)]);
      expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter(attempt => attempt.status === "rejected")).toHaveLength(1);
      const resumed = attempts.find(attempt => attempt.status === "fulfilled")!;
      expect(resumed.status === "fulfilled" && resumed.value.id).toBe(id);
      await entered.promise;
      await expect(resumeMediaGeneration(directory, id)).rejects.toThrow("此任务不能续查");
      expect(methods).toEqual(["GET"]);
      expect(resolveMediaSubmission(directory, id, project.id, actor.id).state).toBe("existing");
      // 供应商查询已开始后注入保存失败，不将预检失败冒充落盘故障。
      writeAtomicSync(occupiedOutput, "late output conflict", { exclusive: true });
      release.resolve();
      for (let attempt = 0; attempt < 100 && getMediaTask(directory, id).status !== "failed"; attempt++) await Bun.sleep(10);
      expect(getMediaTask(directory, id)).toMatchObject({ status: "failed", canResume: true, files: [], providerTaskId: "upstreamOne" });
      expect(readFileSync(occupiedOutput, "utf8")).toBe("late output conflict");
      expect(methods).toEqual(["GET"]);
      renameSync(occupiedOutput, join(directory, "retainedLateConflict"));
      expect((await resumeMediaGeneration(directory, id)).id).toBe(id);
      for (let attempt = 0; attempt < 100 && getMediaTask(directory, id).status !== "succeeded"; attempt++) await Bun.sleep(10);
      const completed = getMediaTask(directory, id);
      expect(completed.status).toBe("succeeded");
      expect(completed.id).toBe(id);
      expect(completed.providerTaskId).toBe("upstreamOne");
      expect(completed.files).toHaveLength(1);
      expect(readFileSync(join(directory, completed.files[0]!.path)).length).toBe(24);
      expect(listMediaTasks(directory).total).toBe(1);
      expect(methods).toEqual(["GET", "GET"]);
      expect(existsSync(join(records, `${id}.submission.json`))).toBe(false);
      const saved = readFileSync(path, "utf8");
      await expect(resumeMediaGeneration(directory, id)).rejects.toThrow("此任务不能续查");
      expect(readFileSync(path, "utf8")).toBe(saved);

      await addMediaProvider('export default { id:"noResume", label:"Local", rules:[], models:[{id:"video",label:"Video",type:"video"}] };');
      const unsupportedId = crypto.randomUUID();
      await startMediaTask(directory, "video", { ...request, providerId: "noResume" }, async (_signal, progress) => {
        progress("running", undefined, "upstreamTwo", configHash); throw new Error("local interruption");
      }, unsupportedId, undefined, actor).completion;
      const unsupportedPath = join(records, `${unsupportedId}.json`), unsupportedBefore = readFileSync(unsupportedPath, "utf8");
      await expect(resumeMediaGeneration(directory, unsupportedId)).rejects.toThrow("不支持续查");
      expect(readFileSync(unsupportedPath, "utf8")).toBe(unsupportedBefore);
      expect(resolveMediaSubmission(directory, unsupportedId, project.id, actor.id).state).toBe("existing");
      expect(existsSync(join(records, `${unsupportedId}.submission.json`))).toBe(false);
      await expect(resumeMediaGeneration(directory, crypto.randomUUID())).rejects.toThrow("生成任务不存在");
      expect(methods).toEqual(["GET", "GET"]);
      await addMediaProvider(`export default { id:"resumePost", label:"Local", rules:[], models:[{id:"video",label:"Video",type:"video"}],
        async resumeVideo() { await this.tool.fetch("http://127.0.0.1:${upstream.port}/forbidden", { method:"POST" }); return []; } };`);
      const postId = crypto.randomUUID();
      await startMediaTask(directory, "video", { ...request, providerId: "resumePost" }, async (_signal, progress) => {
        progress("running", undefined, "upstreamThree", configHash); throw new Error("local interruption");
      }, postId, undefined, actor).completion;
      expect((await resumeMediaGeneration(directory, postId)).id).toBe(postId);
      for (let attempt = 0; attempt < 100 && getMediaTask(directory, postId).status !== "failed"; attempt++) await Bun.sleep(10);
      expect(getMediaTask(directory, postId).status).toBe("failed");
      expect(getMediaTask(directory, postId).files).toEqual([]);
      expect(methods).toEqual(["GET", "GET"]);
      expect(resolveMediaSubmission(directory, postId, project.id, actor.id).state).toBe("existing");
      expect(existsSync(join(records, `${postId}.submission.json`))).toBe(false);
    } finally { release.resolve(); upstream.stop(true); }
  }, 15000);
  if (scenario === "core") {
    test("先创建后确认返回原任务，重复创建只执行一次，确认不改变终态", async () => {
      const { directory, project, records } = createProject("createdFirst");
      const id = crypto.randomUUID();
      let calls = 0;
      const execute = async () => { calls++; throw new Error("local failure"); };
      const operation = startMediaTask(directory, "video", request, execute, id, undefined, actor);
      const recovered = resolveMediaSubmission(directory, id, project.id, actor.id);
      expect(recovered.state).toBe("existing");
      expect(recovered.state === "existing" && recovered.task.id).toBe(id);
      startMediaTask(directory, "video", request, execute, id, undefined, actor);
      await operation.completion;
      const before = readFileSync(join(records, `${id}.json`), "utf8");
      expect(resolveMediaSubmission(directory, id, project.id, actor.id).state).toBe("existing");
      expect(readFileSync(join(records, `${id}.json`), "utf8")).toBe(before);
      expect(calls).toBe(1);
      expect(existsSync(join(records, `${id}.submission.json`))).toBe(false);
      expect(() => resolveMediaSubmission(directory, id, project.id, "anotherActor")).toThrow();
    });
    test("先关闭后迟到提交被拒绝，重复确认幂等且不占任务/成员额度", () => {
      const { directory, project, records } = createProject("closedFirst");
      const id = crypto.randomUUID();
      let calls = 0;
      const closed = resolveMediaSubmission(directory, id, project.id, actor.id);
      expect(closed).toEqual({ state: "closed", requestId: id, projectId: project.id, actorId: actor.id });
      const before = readFileSync(join(records, `${id}.submission.json`), "utf8");
      expect(resolveMediaSubmission(directory, id, project.id, actor.id)).toEqual(closed);
      expect(readFileSync(join(records, `${id}.submission.json`), "utf8")).toBe(before);
      expect(() => startMediaTask(directory, "video", request, async () => { calls++; return []; }, id, undefined, actor)).toThrow();
      expect(calls).toBe(0);
      expect(listMediaTasks(directory).total).toBe(0);
      expect(getMemberGenerationQuota(directory).used).toBe(0);
      expect(() => resolveMediaSubmission(directory, id, project.id, "anotherActor")).toThrow();
      expect(() => resolveMediaSubmission(directory, id, crypto.randomUUID(), actor.id)).toThrow();
    });
    test("坏标记、坏任务与存储失败保持失败关闭，不报告已关闭", async () => {
      const { directory, project, records } = createProject("corruption");
      mkdirSync(records, { recursive: true });
      const markerId = crypto.randomUUID(), taskId = crypto.randomUUID();
      writeAtomicSync(join(records, `${markerId}.submission.json`), "{", { exclusive: true });
      expect(() => resolveMediaSubmission(directory, markerId, project.id, actor.id)).toThrow();
      expect(() => startMediaTask(directory, "video", request, async () => [], markerId, undefined, actor)).toThrow();
      writeAtomicSync(join(records, `${markerId}.submission.json`), "{}");
      expect(() => resolveMediaSubmission(directory, markerId, project.id, actor.id)).toThrow();
      expect(() => startMediaTask(directory, "video", request, async () => [], markerId, undefined, actor)).toThrow();
      writeAtomicSync(join(records, `${taskId}.json`), "{}", { exclusive: true });
      expect(() => resolveMediaSubmission(directory, taskId, project.id, actor.id)).toThrow();
      expect(existsSync(join(records, `${taskId}.submission.json`))).toBe(false);
      const lockedId = crypto.randomUUID(), lockedPath = join(records, `${lockedId}.submission.json`);
      await withFileAccess([lockedPath], "read", () => {
        expect(() => resolveMediaSubmission(directory, lockedId, project.id, actor.id)).toThrow("文件正在使用");
      });
      expect(existsSync(lockedPath)).toBe(false);
      const blocked = createProject("blockedStorage");
      writeAtomicSync(blocked.records, "not a directory", { exclusive: true });
      expect(() => resolveMediaSubmission(blocked.directory, crypto.randomUUID(), blocked.project.id, actor.id)).toThrow();
    });
  }
  if (scenario === "forcedTermination") test("强制终止生成及原子结果写入后恢复原ID，残片不冒充完成文件", async () => {
    const { getMediaTask, resumeMediaTask } = await import("../src/utils/media/tasks");
    const { writeWorkspaceFile } = await import("../src/utils/workspace/files");
    const { directory } = createProject("forcedTermination");
    const run = Number(process.env.toonflowSubmissionRun);
    const id = "33333333-3333-4333-8333-333333333333", hash = "b".repeat(64);
    const content = Buffer.alloc(96 * 1024 * 1024, 37);
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const remnants = readdirSync(directory).filter(file => file.startsWith(".write-")).map(file => ({ file, hash: digest(join(directory, file)) }));
    const execute = async (_signal: AbortSignal, progress: Parameters<Parameters<typeof startMediaTask>[3]>[1]) => {
      progress("running", undefined, "forcedUpstream", hash);
      if (run === 1) {
        writeAtomicSync(join(directory, "ready.json"), "{}");
        await new Promise(() => setInterval(() => {}, 1000));
      }
      progress("saving");
      // 仅故障注入：FileHandle.writeFile支持异步分块输入，停在首块落盘后，由父进程强杀。
      // 公共业务签名仍为Uint8Array，不增加测试专用导出或运行时开关。
      const interruptedContent = (async function* () {
        yield content.subarray(0, 1024 * 1024);
        await new Promise(() => setInterval(() => {}, 1000));
      })();
      await writeWorkspaceFile(join(directory, "result.mp4"), run === 2 ? interruptedContent as unknown as Uint8Array : content, true);
      return [{ path: "result.mp4", mimeType: "video/mp4", mediaType: "video" as const }];
    };
    if (run > 1 && run < 4) expect(getMediaTask(directory, id)).toMatchObject({ status: "interrupted", canResume: true, providerTaskId: "forcedUpstream", files: [] });
    const operation = run === 1 || run === 4 ? startMediaTask(directory, "video", request, execute, id, undefined, actor)
      : resumeMediaTask(directory, id, hash, execute);
    const completed = await operation.completion;
    expect(completed.status).toBe("succeeded");
    expect(completed.id).toBe(id);
    expect(completed.files).toHaveLength(1);
    expect(digest(join(directory, "result.mp4"))).toBe(createHash("sha256").update(content).digest("hex"));
    for (const remnant of remnants) expect(digest(join(directory, remnant.file))).toBe(remnant.hash);
    expect(listMediaTasks(directory).total).toBe(1);
  }, 30000);
  if (scenario === "recoveryRestart") test("生成中退出、续查中再次退出后仍复用原ID，完成重启不重复保存", async () => {
    const { getMediaTask, resumeMediaTask } = await import("../src/utils/media/tasks");
    const { directory, records } = createProject("recoveryRestart");
    const id = "22222222-2222-4222-8222-222222222222";
    const run = Number(process.env.toonflowSubmissionRun);
    const hash = "a".repeat(64);
    const tracePath = join(directory, "attempts.json");
    const trace: string[] = existsSync(tracePath) ? JSON.parse(readFileSync(tracePath, "utf8")) : [];
    const entered = Promise.withResolvers<void>();
    const execute = async (_signal: AbortSignal, progress: Parameters<Parameters<typeof startMediaTask>[3]>[1]) => {
      trace.push(run === 1 ? "generate" : "resume");
      writeAtomicSync(tracePath, JSON.stringify(trace));
      progress("running", undefined, "upstreamRestart", hash);
      entered.resolve();
      if (run < 3) return new Promise<never>(() => {});
      const result = { path: "result.mp4", mimeType: "video/mp4", mediaType: "video" as const };
      writeAtomicSync(join(directory, result.path), "local preserved result", { exclusive: true });
      progress("saving", [result]);
      return [result];
    };
    if (run === 4) {
      const before = readFileSync(join(records, `${id}.json`), "utf8");
      const done = await startMediaTask(directory, "video", request, execute, id, undefined, actor).completion;
      expect(done.status).toBe("succeeded");
      expect(trace).toEqual(["generate", "resume", "resume"]);
      expect(readFileSync(join(records, `${id}.json`), "utf8")).toBe(before);
      expect(readFileSync(join(directory, "result.mp4"), "utf8")).toBe("local preserved result");
      return;
    }
    if (run > 1) {
      expect(getMediaTask(directory, id)).toMatchObject({ status: "interrupted", canResume: true, providerTaskId: "upstreamRestart" });
    }
    const operation = run === 1 ? startMediaTask(directory, "video", request, execute, id, undefined, actor)
      : resumeMediaTask(directory, id, hash, execute);
    await entered.promise;
    expect(operation.task.id).toBe(id);
    expect(getMediaTask(directory, id).providerTaskId).toBe("upstreamRestart");
    if (run === 3) {
      expect((await operation.completion).status).toBe("succeeded");
      expect(getMediaTask(directory, id).timeline?.filter(event => event.status === "interrupted")).toHaveLength(2);
      expect(listMediaTasks(directory).total).toBe(1);
    } else {
      // 子进程测试结束时退出，保留在途快照给下一独立进程；不完成也不取消旧执行。
      expect(JSON.parse(readFileSync(join(records, `${id}.json`), "utf8")).status).toBe("running");
    }
  });
  if (scenario === "restart") test("关闭标记重启保留，旧恢复只传ID即可确认", () => {
    const { directory, project } = createProject("restart");
    const id = "11111111-1111-4111-8111-111111111111";
    if (process.env.toonflowSubmissionRun === "1") expect(resolveMediaSubmission(directory, id, project.id, actor.id).state).toBe("closed");
    else {
      expect(resolveMediaSubmission(directory, id, project.id, actor.id).state).toBe("closed");
      expect(() => startMediaTask(directory, "video", request, async () => [], id, undefined, actor)).toThrow();
      expect(listMediaTasks(directory).total).toBe(0);
    }
  });
  if (scenario === "http") test("真实HTTP认证、跨成员/项目拒绝与同ID恢复，不调用供应商", async () => {
    const { createApp } = await import("../src/app");
    const app = await createApp({ dataDirectory: join(childRoot, "data"), webRoot: join(childRoot, "web") });
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("未取得端口");
      const origin = `http://127.0.0.1:${address.port}`;
      const send = (path: string, cookie = "", body?: unknown, extra: Record<string, string> = {}, method = "POST") => fetch(`${origin}/api/${path}`, {
        method, headers: { origin, cookie, "x-toonflow-workspace": "1", "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect((await send("ai/media/tasks/resolveSubmission", "", {})).status).toBe(401);
      const login = async (username: string) => {
        const response = await send("auth/login", "", { username, password: "temporaryRecoveryPassword" });
        expect(response.status).toBe(200);
        return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, id: (await response.json()).data.user.id };
      };
      const admin = await login("recoveryAdmin");
      const users: { cookie: string; id: string }[] = [];
      for (const username of ["recoverOne", "recoverTwo"]) {
        expect((await send("users/create", admin.cookie, { username, password: "temporaryRecoveryPassword", role: "user" })).status).toBe(201);
        users.push(await login(username));
      }
      const one = users[0]!, two = users[1]!;
      const { directory, project } = createProject("http");
      expect((await send("projects/members", admin.cookie, { id: project.id, members: [one.id, two.id] }, {}, "PUT")).status).toBe(200);
      const headers = { "x-toonflow-project-id": project.id, "x-toonflow-user-id": one.id };
      const input = { directory, requestId: crypto.randomUUID() };
      expect((await send("ai/media/tasks/resolveSubmission", one.cookie, input, { "x-toonflow-project-id": project.id })).status).toBe(403);
      expect((await send("ai/media/tasks/resolveSubmission", one.cookie, input, { ...headers, "x-toonflow-user-id": two.id })).status).toBe(403);
      const closed = await send("ai/media/tasks/resolveSubmission", one.cookie, input, headers);
      expect(closed.status).toBe(200);
      expect((await closed.json()).data).toEqual({ state: "closed", requestId: input.requestId, projectId: project.id, actorId: one.id });
      expect((await send("ai/media/tasks/resolveSubmission", two.cookie, input, { ...headers, "x-toonflow-user-id": two.id })).status).toBe(403);
      const other = createProject("otherProject");
      expect((await send("ai/media/tasks/resolveSubmission", one.cookie, { ...input, directory: other.directory }, headers)).status).toBe(403);
      expect((await send("ai/media/tasks/resolveSubmission", one.cookie, { ...input, requestId: "invalid" }, headers)).status).toBe(400);
      const existingId = crypto.randomUUID();
      await startMediaTask(directory, "video", request, async () => { throw new Error("local failure"); }, existingId, undefined, { id: one.id, username: "recoverOne", member: false }).completion;
      const existing = await send("ai/media/tasks/resolveSubmission", one.cookie, { directory, requestId: existingId }, headers);
      expect(existing.status).toBe(200);
      expect((await existing.json()).data.state).toBe("existing");
      const adminHeaders = { "x-toonflow-project-id": project.id, "x-toonflow-user-id": admin.id };
      const adminInput = { directory, requestId: crypto.randomUUID() };
      expect((await send("ai/media/tasks/resolveSubmission", admin.cookie, adminInput, adminHeaders)).status).toBe(200);
      const late = await send("ai/media/tasks/create", admin.cookie, { ...adminInput, mediaType: "video", providerId: "missingProvider", modelId: "missingModel", prompt: "late request" }, adminHeaders);
      expect(late.status).toBe(409);
      for (let count = 1; count < 30; count++) expect((await send("ai/media/tasks/resolveSubmission", admin.cookie, adminInput, adminHeaders)).status).toBe(200);
      const limited = await send("ai/media/tasks/resolveSubmission", admin.cookie, adminInput, adminHeaders);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await send("projects/members", admin.cookie, { id: project.id, members: [] }, {}, "PUT")).status).toBe(200);
      expect((await send("ai/media/tasks/resolveSubmission", one.cookie, input, headers)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
