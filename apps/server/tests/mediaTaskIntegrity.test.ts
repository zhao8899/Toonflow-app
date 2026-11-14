import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, withFileAccess, writeAtomicSync } from "@toonflow/file";

const childRoot = process.env.toonflowIntegrityTestRoot;
if (!childRoot) {
  test("独立进程验证任务损坏隔离与计费失败关闭", async () => {
    const root = mkdtempSync(join(tmpdir(), "toonflowIntegrity"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, toonflowIntegrityTestRoot: root, TOONFLOW_DATA_DIR: join(root, "data"), TOONFLOW_AUTH_REQUIRED: "false", NODE_ENV: "test" },
        stdout: "inherit", stderr: "inherit",
      });
      timer = setTimeout(() => child?.kill("SIGKILL"), 30000);
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}toonflowIntegrity`)) throw new Error("临时目录越界");
      rmSync(root, { recursive: true, force: true });
    }
  }, 45000);
} else {
  if (!resolve(childRoot).startsWith(`${resolve(tmpdir())}${sep}toonflowIntegrity`)) throw new Error("临时目录越界");
  const { listMediaTasks, startMediaTask, getMediaTask, getMemberGenerationQuota, exportMediaTaskCosts, cancelMediaTask } = await import("../src/utils/media/tasks");
  const { registerProject } = await import("../src/utils/workspace/projects");

  test("启动兼容处理保留已有供应商配置，仅补充市场密钥", async () => {
    const { default: conf } = await import("../src/utils/conf");
    const { default: migrateProviderDefaults } = await import("../src/utils/providerDefaults");
    const previous = conf.get("settings", {});
    const settings = { providerDefaultsVersion: 1,
      customProviders: [{ id: "tfRouter", apiUrl: "https://api.toonflow.net/v1", apiKey: "localTestKey", models: ["existing"] },
        { id: "privateProvider", apiUrl: "https://example.invalid/v1", apiKey: "localPrivateKey" }],
      mediaProviderConfigs: { tfRouter: { apiKey: "localTestKey" }, privateProvider: { apiKey: "localPrivateKey" } },
      promptEnhancementModel: { providerId: "tfRouter", modelId: "existing" } };
    try {
      conf.set("settings", settings);
      await migrateProviderDefaults();
      expect(conf.get("settings")).toEqual({ ...settings, pluginMarketApiKey: "localTestKey" });
      conf.set("settings.pluginMarketApiKey", "explicitMarketKey");
      await migrateProviderDefaults();
      expect(conf.get("settings")).toEqual({ ...settings, pluginMarketApiKey: "explicitMarketKey" });
    } finally { conf.set("settings", previous); }
  });

  test("视频提交前按能力校验组合及素材，未知能力不猜测且供应商零调用", async () => {
    const { addMediaProvider } = await import("../src/utils/media/provider");
    const { submitMediaGeneration, getMediaPrice } = await import("../src/utils/media/generation");
    const directory = mkdtempSync(join(childRoot, "preflightWorkspace"));
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("ok"); } });
    try {
      const capability = { mode: ["text", "singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", ["imageReference:2", "audioReference:1"]], audio: false,
        durationResolutionMap: [{ duration: [4], resolution: ["720p"] }, { duration: [8], resolution: ["1080p"] }] };
      const models = [
        { id: "video", label: "Video", type: "video", ...capability },
        { id: "unknown", label: "Unknown", type: "video" },
        { id: "unknownAudio", label: "Unknown audio", type: "video", ...capability, audio: undefined },
        { id: "alwaysAudio", label: "Always audio", type: "video", ...capability, audio: true },
        { id: "optionalAudio", label: "Optional audio", type: "video", ...capability, audio: "optional" },
      ];
      await addMediaProvider(`export default { id:"preflightLocal", label:"Local", rules:[], models:${JSON.stringify(models)},
        async generateVideo() { await this.tool.fetch("http://127.0.0.1:${server.port}/generated"); return [{ type:"base64",mediaType:"video",mimeType:"video/mp4",data:"AAAAGGZ0eXBpc29tAAACAGlzb21pc28y" }]; } };`);
      const input = { providerId: "preflightLocal", modelId: "video", prompt: "local only", mode: "text" as const, duration: 4, resolution: "720p", generateAudio: false };
      const image = { path: "missing.png", mimeType: "image/png" };
      for (const [patch, message] of [
        [{ modelId: "unknown" }, "生成模式尚未确认"], [{ modelId: "unknownAudio" }, "音频能力尚未确认"],
        [{ mode: undefined }, "请选择视频生成模式"], [{ mode: ["videoReference:1"] }, "不支持所选视频模式"],
        [{ duration: undefined }, "请选择明确的视频时长"], [{ duration: 8 }, "不支持所选时长与分辨率组合"],
        [{ resolution: "1080p" }, "不支持所选时长与分辨率组合"], [{ generateAudio: true }, "不支持生成音频"],
        [{ modelId: "alwaysAudio", generateAudio: false }, "始终输出音频"], [{ generateAudio: undefined }, "请选择是否生成音频"],
        [{ images: [image] }, "文生视频模式不能附带"], [{ mode: "singleImage" }, "单图模式需要"],
        [{ mode: "singleImage", firstFrame: image }, "不能混用首尾帧字段"],
        [{ mode: "startEndRequired", firstFrame: image }, "首尾帧输入"],
        [{ mode: ["imageReference:2", "audioReference:1"], images: [image, image, image] }, "数量超出"],
      ] as const) {
        const request = { ...input, ...patch } as any;
        await expect(submitMediaGeneration(directory, "video", request, crypto.randomUUID())).rejects.toThrow(message);
        await expect(getMediaPrice(directory, "video", request)).rejects.toThrow(message);
      }
      expect(listMediaTasks(directory).total).toBe(0);
      expect(calls).toBe(0);
      for (const patch of [
        { mode: "singleImage", images: [image] }, { mode: "startEndRequired", firstFrame: image, lastFrame: image },
        { mode: "endFrameOptional", firstFrame: image }, { mode: "startFrameOptional", lastFrame: image },
        { mode: ["audioReference:1", "imageReference:2"], images: [image] },
        { modelId: "alwaysAudio", generateAudio: true }, { modelId: "optionalAudio", generateAudio: false },
      ]) expect(await getMediaPrice(directory, "video", { ...input, ...patch } as any)).toBeNull();
      expect(calls).toBe(0);
      const id = crypto.randomUUID();
      await submitMediaGeneration(directory, "video", input, id);
      for (let attempt = 0; attempt < 100 && getMediaTask(directory, id).status !== "succeeded"; attempt++) await Bun.sleep(10);
      expect(getMediaTask(directory, id).status).toBe("succeeded");
      expect(calls).toBe(1);
      await submitMediaGeneration(directory, "video", input, id);
      expect(calls).toBe(1);
      const { getMediaProvider, saveMediaProvider } = await import("../src/utils/media/provider");
      const provider = await getMediaProvider("preflightLocal");
      await saveMediaProvider(provider.fileName, [], provider.revision);
      expect((await submitMediaGeneration(directory, "video", input, id)).id).toBe(id);
      await expect(submitMediaGeneration(directory, "video", input, crypto.randomUUID())).rejects.toThrow("所选媒体模型不存在");
      expect(calls).toBe(1);
    } finally { server.stop(true); }
  });

  test("混合模型目录跳过未知能力并保留配置，空导入不写盘且跨源不发送Key", async () => {
    const { addMediaProvider, getMediaProvider, refreshMediaProviderModels } = await import("../src/utils/media/provider");
    const { default: conf } = await import("../src/utils/conf");
    let rows: Record<string, unknown>[] = [
      { id: "textOnly", supported_endpoint_types: ["openai"] },
      { id: "knownVideo", supported_endpoint_types: ["openai-video"], label: "Remote changed" },
      { id: "unknownVideo", supported_endpoint_types: ["openai-video"] },
      { id: "missingCapabilities", type: "video" },
      { id: "emptyCapabilities", type: "video", mode: ["text"], audio: false, durationResolutionMap: [{ duration: [], resolution: [] }] },
      { id: "explicitVideo", type: "video", modelInfo: { mode: ["text"], audio: false, durationResolutionMap: [{ duration: [4], resolution: ["720p"] }] } },
      { id: "newImage", type: "image", label: "New image" },
    ];
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      calls++; expect(req.headers.get("authorization")).toBe("Bearer syntheticOnly");
      return Response.json({ data: rows });
    } });
    const sourcePath = join(childRoot, "data", "providers", "mixedCatalog.ts");
    try {
      const initial = await addMediaProvider(`export default { id:"mixedCatalog", label:"Local", rules:[], modelsUrl:"http://127.0.0.1:${server.port}/models", models:[
        {id:"knownVideo", label:"User label", type:"video", mode:["text"], audio:false, durationResolutionMap:[{duration:[4],resolution:["720p"]}]},
        {id:"retainedImage", label:"Keep", type:"image"}] };`);
      conf.set("settings.mediaProviderConfigs.mixedCatalog", { apiKey: "syntheticOnly" });
      const result = await refreshMediaProviderModels("mixedCatalog.ts", initial.revision);
      expect(result.models).toHaveLength(4);
      expect(result.models.find(model => model.id === "knownVideo")).toMatchObject(initial.models[0]!);
      expect(result.models.some(model => model.id === "retainedImage")).toBe(true);
      expect(result.refreshSummary.imported).toBe(3);
      expect(result.refreshSummary.skipped.map(item => item.id).sort()).toEqual(["emptyCapabilities", "missingCapabilities", "textOnly", "unknownVideo"]);
      expect(result.refreshSummary.preserved).toBe(2);
      const before = readFileSync(sourcePath, "utf8");
      rows = [{ id: "textOnly", supported_endpoint_types: ["openai"] }, { id: "knownVideo", type: "text" }];
      const skipped = await refreshMediaProviderModels("mixedCatalog.ts", result.revision, "video");
      expect(skipped.refreshSummary.imported).toBe(0);
      expect(skipped.refreshSummary.skipped).toHaveLength(2);
      expect(readFileSync(sourcePath, "utf8")).toBe(before);
      rows = [{ id: "duplicate", type: "image" }, { id: " duplicate ", type: "image" }];
      await expect(refreshMediaProviderModels("mixedCatalog.ts", result.revision)).rejects.toThrow("ID 不能重复");
      expect(readFileSync(sourcePath, "utf8")).toBe(before);
      rows = [{ id: " ", type: "image" }];
      await expect(refreshMediaProviderModels("mixedCatalog.ts", result.revision)).rejects.toThrow();
      expect(readFileSync(sourcePath, "utf8")).toBe(before);
      const requestsBefore = calls;
      conf.set("settings.mediaProviderConfigs.mixedCatalog.baseUrl", "https://example.invalid/v1");
      await expect(refreshMediaProviderModels("mixedCatalog.ts", result.revision)).rejects.toThrow("未发送 API Key");
      expect(calls).toBe(requestsBefore);
      expect((await getMediaProvider("mixedCatalog")).revision).toBe(result.revision);
    } finally { conf.delete("settings.mediaProviderConfigs.mixedCatalog"); server.stop(true); }
  });

  test("输出目录被文件占用时提交前失败，保留原文件且不调用供应商", async () => {
    const { addMediaProvider } = await import("../src/utils/media/provider");
    const { submitMediaGeneration } = await import("../src/utils/media/generation");
    const directory = mkdtempSync(join(childRoot, "outputConflict"));
    writeAtomicSync(join(directory, "occupied"), "keep existing content");
    let calls = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("ok"); } });
    try {
      await addMediaProvider(`export default { id:"outputConflict", label:"Local", rules:[], models:[{id:"image",label:"Image",type:"image"}],
        async generateImage() { await this.tool.fetch("http://127.0.0.1:${upstream.port}/generate"); return [{type:"base64",mediaType:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="}]; } };`);
      const id = crypto.randomUUID();
      const input = { providerId: "outputConflict", modelId: "image", prompt: "local only", outputDirectory: "occupied" };
      await submitMediaGeneration(directory, "image", input, id);
      for (let attempt = 0; attempt < 100 && ["queued", "running", "saving"].includes(getMediaTask(directory, id).status); attempt++) await Bun.sleep(10);
      expect(getMediaTask(directory, id)).toMatchObject({ status: "failed", billingState: "notSubmitted", files: [] });
      expect(calls).toBe(0);
      expect(readFileSync(join(directory, "occupied"), "utf8")).toBe("keep existing content");
      expect((await submitMediaGeneration(directory, "image", input, id)).id).toBe(id);
      expect(calls).toBe(0);
    } finally { upstream.stop(true); }
  });

  test("同工作区并发生成等待保存，结果都落盘且同ID重发不再保存", async () => {
    const { addMediaProvider } = await import("../src/utils/media/provider");
    const { submitMediaGeneration } = await import("../src/utils/media/generation");
    await addMediaProvider(`export default { id: "saveConcurrency", label: "Local", rules: [], models: [{ id: "image", label: "Image", type: "image" }],
      async generateImage() { return [{ type: "base64", mediaType: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }]; } };`);
    const directory = mkdtempSync(join(childRoot, "saveWorkspace"));
    const output = join(directory, "assets", "generated");
    mkdirSync(output, { recursive: true });
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const blocker = withFileAccess([output], "read", async () => { held.resolve(); await release.promise; });
    await held.promise;
    const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
    try {
      await Promise.all(ids.map(id => submitMediaGeneration(directory, "image", { providerId: "saveConcurrency", modelId: "image", prompt: "local only" }, id)));
      for (let attempt = 0; attempt < 100; attempt++) {
        if (ids.every(id => ["saving", "failed"].includes(getMediaTask(directory, id).status))) break;
        await Bun.sleep(10);
      }
      expect(ids.map(id => getMediaTask(directory, id).status)).toEqual(Array(8).fill("saving"));
      expect((await submitMediaGeneration(directory, "image", { providerId: "saveConcurrency", modelId: "image", prompt: "local only" }, ids[0]!)).id).toBe(ids[0]!);
      const overflowId = crypto.randomUUID();
      await expect(submitMediaGeneration(directory, "image", { providerId: "saveConcurrency", modelId: "image", prompt: "local only" }, overflowId)).rejects.toThrow("已达上限");
      expect(() => getMediaTask(directory, overflowId)).toThrow("生成任务不存在");
    } finally { release.resolve(); await blocker; }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (ids.every(id => ["succeeded", "failed"].includes(getMediaTask(directory, id).status))) break;
      await Bun.sleep(10);
    }
    const tasks = ids.map(id => getMediaTask(directory, id));
    expect(tasks.map(task => task.status)).toEqual(Array(8).fill("succeeded"));
    expect(new Set(tasks.flatMap(task => task.files.map(file => file.path))).size).toBe(8);
    for (const task of tasks) expect(readFileSync(join(directory, task.files[0]!.path)).length).toBeGreaterThan(0);
    const repeated = await submitMediaGeneration(directory, "image", { providerId: "saveConcurrency", modelId: "image", prompt: "local only" }, ids[0]!);
    expect(repeated.files).toEqual(tasks[0]!.files);
  });

  test("保存队列等待可取消，后续任务与根目录输出不死锁", async () => {
    const { submitMediaGeneration } = await import("../src/utils/media/generation");
    const directory = mkdtempSync(join(childRoot, "cancelSaveWorkspace"));
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const blocker = withFileAccess([directory], "write", async () => { held.resolve(); await release.promise; });
    await held.promise;
    const id = crypto.randomUUID();
    try {
      await submitMediaGeneration(directory, "image", { providerId: "saveConcurrency", modelId: "image", prompt: "local only" }, id);
      for (let attempt = 0; attempt < 100 && getMediaTask(directory, id).status !== "saving"; attempt++) await Bun.sleep(10);
      expect(getMediaTask(directory, id).status).toBe("saving");
      cancelMediaTask(directory, id);
      for (let attempt = 0; attempt < 100 && getMediaTask(directory, id).status !== "cancelled"; attempt++) await Bun.sleep(10);
      expect(getMediaTask(directory, id).status).toBe("cancelled");
      expect(getMediaTask(directory, id).files).toEqual([]);
    } finally { release.resolve(); await blocker; }
    for (const outputDirectory of [".", ""]) {
      const nextId = crypto.randomUUID();
      const input = { providerId: "saveConcurrency", modelId: "image", prompt: "local only", outputDirectory };
      await submitMediaGeneration(directory, "image", input, nextId);
      for (let attempt = 0; attempt < 100 && getMediaTask(directory, nextId).status !== "succeeded"; attempt++) await Bun.sleep(10);
      const completed = getMediaTask(directory, nextId);
      expect(completed.status).toBe("succeeded");
      expect(completed.files).toHaveLength(1);
      expect(completed.files[0]!.path).not.toContain("/");
      expect(readFileSync(join(directory, completed.files[0]!.path)).length).toBeGreaterThan(0);
      expect((await submitMediaGeneration(directory, "image", input, nextId)).files).toEqual(completed.files);
      expect(listMediaTasks(directory).tasks.find(task => task.id === nextId)?.files).toEqual(completed.files);
    }
  });

  test("并发任务部分保存失败保留已写文件，同ID重发不补生成且不影响其他任务", async () => {
    const { addMediaProvider } = await import("../src/utils/media/provider");
    const { submitMediaGeneration } = await import("../src/utils/media/generation");
    await addMediaProvider(`export default { id:"partialSave",label:"Local",rules:[],models:[{id:"image",label:"Image",type:"image"}],
      async generateImage(){return [{type:"base64",mediaType:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="},{type:"base64",mediaType:"image",mimeType:"image/png",data:""}];}};`);
    const directory = mkdtempSync(join(childRoot, "partialSave"));
    const failedId = crypto.randomUUID(), healthyId = crypto.randomUUID();
    const input = { providerId: "partialSave", modelId: "image", prompt: "local only" };
    await Promise.all([
      submitMediaGeneration(directory, "image", input, failedId),
      submitMediaGeneration(directory, "image", { ...input, providerId: "saveConcurrency" }, healthyId),
    ]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ([failedId, healthyId].every(id => ["failed", "succeeded"].includes(getMediaTask(directory, id).status))) break;
      await Bun.sleep(10);
    }
    const failed = getMediaTask(directory, failedId), healthy = getMediaTask(directory, healthyId);
    expect(failed.status).toBe("failed");
    expect(failed.files).toHaveLength(1);
    expect(healthy.status).toBe("succeeded");
    expect(healthy.files).toHaveLength(1);
    expect(failed.files[0]!.path).not.toBe(healthy.files[0]!.path);
    const before = readFileSync(join(directory, failed.files[0]!.path));
    expect(before.length).toBeGreaterThan(0);
    expect((await submitMediaGeneration(directory, "image", input, failedId)).files).toEqual(failed.files);
    expect(readFileSync(join(directory, failed.files[0]!.path))).toEqual(before);
    expect(listMediaTasks(directory).total).toBe(2);
  });

  async function projectWithTask() {
    const parent = join(childRoot, "data", "workspaces");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "project"));
    registerProject(directory, "记录完整性验证", "localTest");
    const operation = startMediaTask(directory, "video", { providerId: "localTest", modelId: "video", prompt: "integrity regression" }, async () => {
      throw new Error("本地失败路径，不调用供应商");
    });
    await operation.completion;
    const normalized = process.platform === "win32" ? directory.toLowerCase() : directory;
    const records = join(childRoot, "data", "mediaTasks", createHash("sha256").update(normalized).digest("hex"));
    return { directory, records, id: operation.task.id };
  }

  test("JSON 与结构损坏明确报告，正常任务可分页筛选，原始损坏文件不变", async () => {
    const project = await projectWithTask();
    const syntaxId = crypto.randomUUID(), schemaId = crypto.randomUUID();
    const malformed = '{"id":';
    writeAtomicSync(join(project.records, `${syntaxId}.json`), malformed, { exclusive: true });
    writeAtomicSync(join(project.records, `${schemaId}.json`), "{}", { exclusive: true });
    const result = listMediaTasks(project.directory, 0, 1, {}, true);
    expect(result.total).toBe(1);
    expect(result.tasks.map(task => task.id)).toEqual([project.id]);
    expect(result.corruptCount).toBe(2);
    expect(result.corruptTaskIds.sort()).toEqual([syntaxId, schemaId].sort());
    expect(listMediaTasks(project.directory, 1, 1, {}, true).tasks).toEqual([]);
    const filtered = listMediaTasks(project.directory, 0, 1, { status: "succeeded" }, true);
    expect(filtered.total).toBe(0);
    expect(filtered.corruptCount).toBe(2);
    expect(readFileSync(join(project.records, `${syntaxId}.json`), "utf8")).toBe(malformed);
    expect(readFileSync(join(project.records, `${schemaId}.json`), "utf8")).toBe("{}");
    expect(() => getMediaTask(project.directory, syntaxId)).toThrow();
  });

  test("任务文件ID错配拒绝读取复用与恢复，浏览隔离且原始记录不变", async () => {
    const project = await projectWithTask();
    const { getMediaTaskRecovery, resumeMediaTask } = await import("../src/utils/media/tasks");
    const wrongId = crypto.randomUUID();
    const original = readFileSync(join(project.records, `${project.id}.json`), "utf8");
    const path = join(project.records, `${wrongId}.json`);
    // 模拟复制错位的在途记录；读取不得先将其改写为interrupted。
    const mismatched = JSON.stringify({ ...JSON.parse(original), status: "running", providerTaskId: "upstreamOne", providerConfigHash: "a".repeat(64) });
    writeAtomicSync(path, mismatched, { exclusive: true });
    expect(() => getMediaTask(project.directory, wrongId)).toThrow("任务记录与文件 ID 不匹配");
    expect(() => getMediaTaskRecovery(project.directory, wrongId)).toThrow("任务记录与文件 ID 不匹配");
    let executions = 0;
    const execute = async () => { executions++; return []; };
    expect(() => resumeMediaTask(project.directory, wrongId, "a".repeat(64), execute)).toThrow("任务记录与文件 ID 不匹配");
    expect(() => startMediaTask(project.directory, "video", { providerId: "localTest", modelId: "video", prompt: "local" }, execute, wrongId)).toThrow("任务记录与文件 ID 不匹配");
    expect(executions).toBe(0);
    expect(listMediaTasks(project.directory, 0, 30, {}, true)).toMatchObject({ total: 1, corruptCount: 1, corruptTaskIds: [wrongId] });
    expect(() => getMemberGenerationQuota(project.directory)).toThrow();
    expect(() => exportMediaTaskCosts(project.directory)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(mismatched);
    expect(readFileSync(join(project.records, `${project.id}.json`), "utf8")).toBe(original);
  });

  test("默认列表、成员额度与成本导出遇到损坏继续失败关闭", async () => {
    const project = await projectWithTask();
    writeAtomicSync(join(project.records, `${crypto.randomUUID()}.json`), "{}", { exclusive: true });
    expect(() => listMediaTasks(project.directory)).toThrow();
    expect(() => getMemberGenerationQuota(project.directory)).toThrow();
    expect(() => exportMediaTaskCosts(project.directory)).toThrow();
  });

  test("损坏 ID 最多返回十个但总损坏数完整", async () => {
    const project = await projectWithTask();
    for (let index = 0; index < 12; index++) writeAtomicSync(join(project.records, `${crypto.randomUUID()}.json`), "null", { exclusive: true });
    const result = listMediaTasks(project.directory, 0, 30, {}, true);
    expect(result.corruptCount).toBe(12);
    expect(result.corruptTaskIds.length).toBe(10);
    expect(result.total).toBe(1);
  });

  test("全部损坏与空项目明确区分", async () => {
    const project = await projectWithTask();
    writeAtomicSync(join(project.records, `${project.id}.json`), "{}");
    const corrupted = listMediaTasks(project.directory, 0, 30, {}, true);
    expect(corrupted.tasks).toEqual([]);
    expect(corrupted.total).toBe(0);
    expect(corrupted.corruptCount).toBe(1);
    const empty = listMediaTasks(join(childRoot, "emptyProject"), 0, 30, {}, true);
    expect(empty).toEqual({ tasks: [], total: 0, corruptCount: 0, corruptTaskIds: [] });
  });

  test("读取故障与恢复状态写入故障不会被伪装为损坏隔离", async () => {
    const project = await projectWithTask();
    const file = join(project.records, `${project.id}.json`);
    await withFileAccess([file], "write", () => {
      expect(() => listMediaTasks(project.directory, 0, 30, {}, true)).toThrow("文件正在使用");
    });
    const record = JSON.parse(readFileSync(file, "utf8"));
    writeAtomicSync(file, JSON.stringify({ ...record, status: "running" }));
    await withFileAccess([file], "read", () => {
      expect(() => listMediaTasks(project.directory, 0, 30, {}, true)).toThrow("文件正在使用");
    });
    expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("running");
  });

  test("真实列表 HTTP 返回不完整标记与正常任务，成本导出不返回不完整账单", async () => {
    const project = await projectWithTask();
    const brokenId = crypto.randomUUID();
    writeAtomicSync(join(project.records, `${brokenId}.json`), "{", { exclusive: true });
    const { createApp } = await import("../src/app");
    const app = await createApp({ dataDirectory: join(childRoot, "data"), webRoot: join(childRoot, "web") });
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("未取得监听端口");
      const origin = `http://127.0.0.1:${address.port}`;
      const headers = { origin, "x-toonflow-workspace": "1" };
      const query = new URLSearchParams({ directory: project.directory });
      const response = await fetch(`${origin}/api/ai/media/tasks/list?${query}`, { headers });
      expect(response.status).toBe(200);
      const body = (await response.json()).data;
      expect(body.corruptCount).toBe(1);
      expect(body.corruptTaskIds).toEqual([brokenId]);
      expect(body.tasks.map((task: { id: string }) => task.id)).toEqual([project.id]);
      const costs = await fetch(`${origin}/api/ai/media/tasks/costExport?${query}`, { headers });
      expect(costs.ok).toBe(false);
      expect((await costs.json()).data).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  test("生成准备等待期间撤销授权不创建任务或调用供应商", async () => {
    const { addMediaProvider } = await import("../src/utils/media/provider");
    const { submitMediaGeneration } = await import("../src/utils/media/generation");
    const directory = mkdtempSync(join(childRoot, "inflightGrant"));
    let calls = 0;
    const supplier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("unexpected"); } });
    try {
      await addMediaProvider(`export default { id:"inflightGrant", label:"Local", rules:[], models:[{id:"video",label:"Video",type:"video",mode:["text"],audio:false,durationResolutionMap:[{duration:[4],resolution:["720p"]}]}], async generateVideo() { await this.tool.fetch("http://127.0.0.1:${supplier.port}/generate"); return []; } };`);
      let revoked = false, checks = 0, settled = false;
      let operation: Promise<unknown>;
      await withFileAccess([join(childRoot, "data/providers/inflightGrant.ts")], "write", async () => {
        operation = submitMediaGeneration(directory, "video", {providerId:"inflightGrant",modelId:"video",prompt:"local only",mode:"text",duration:4,resolution:"720p",generateAudio:false}, crypto.randomUUID(), undefined, () => { checks++; if (revoked) throw Object.assign(new Error("授权已撤销"), { status: 403 }); });
        void operation.then(() => { settled = true; }, () => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(checks).toBeGreaterThan(0); expect(settled).toBe(false);
        revoked = true;
      });
      await expect(operation!).rejects.toThrow("授权已撤销");
      expect(calls).toBe(0); expect(listMediaTasks(directory).total).toBe(0);
    } finally { await supplier.stop(true); }
  });

}
