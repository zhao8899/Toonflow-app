import { afterAll, expect, spyOn, test } from "bun:test";
import express from "express";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { cp, mkdir, mkdtemp, rm } from "@toonflow/file";

const childRoot = process.env.toonflowPromptActivityTestRoot;
if (!childRoot) {
  test("独立进程验证提示词结果与日志失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "toonflowPromptActivity"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, toonflowPromptActivityTestRoot: root, TOONFLOW_DATA_DIR: root, NODE_ENV: "test" },
        stdout: "inherit", stderr: "inherit",
      });
      timeout = setTimeout(() => child?.kill("SIGKILL"), 30000);
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timeout);
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}toonflowPromptActivity`)) throw new Error("临时目录越界");
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
} else {
  if (!resolve(childRoot).startsWith(`${resolve(tmpdir())}${sep}toonflowPromptActivity`)) throw new Error("临时目录越界");
  const directory = join(childRoot, "workspaces", "project");
  await mkdir(directory, { recursive: true });
  await mkdir(join(childRoot, "providers"));
  await cp(resolve(import.meta.dirname, "../../../packages/providers/src/media/daochengCloud.ts"), join(childRoot, "providers", "daochengCloud.ts"));
  const { default: u } = await import("../src/utils");
  u.conf.set("settings", {
    promptEnhancementModel: { providerId: "testProvider", modelId: "testModel" },
    customProviders: [{ id: "testProvider", apiUrl: "http://127.0.0.1:1", apiKey: "test-only-placeholder", protocol: "openai-completions", models: [{ id: "testModel", label: "test" }] }],
  });
  const models = await u.mediaGeneration.listMediaModels();
  const model = models.find(item => item.type === "video" && item.mode?.includes("text") && item.durationResolutionMap?.length);
  if (!model) throw new Error("本地供应商无可用纯文本视频模型");
  const input = { directory, providerId: model.providerId, modelId: model.modelId, prompt: "猫走过庭院", mode: "text", duration: model.durationResolutionMap![0]!.duration[0], resolution: model.durationResolutionMap![0]!.resolution[0], ratio: "16:9", generateAudio: model.audio === true };
  let output: object = { status: "enhanced", enhancedPrompt: "猫缓步走过庭院，镜头平稳跟随。", changeSummary: "明确动作和镜头" };
  let failKind = "";
  const originalRecord = u.activity.recordActivity;
  const record = spyOn(u.activity, "recordActivity").mockImplementation(event => {
    if (event.kind === failKind) throw Object.assign(new Error("测试日志容量不足"), { status: 507 });
    originalRecord(event);
  });
  const stream = spyOn(u.ai, "streamAi").mockImplementation(() => ({
    async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: JSON.stringify(output) }; },
    async result() { return { stopReason: "stop" }; },
  }) as ReturnType<typeof u.ai.streamAi>);
  const { default: route } = await import("../src/routes/ai/media/tasks/enhancePrompt");
  const { errorFromCause } = await import("../src/lib/responseFormat");
  const app = express();
  app.use(express.json());
  app.use("/enhancePrompt", route);
  app.use((cause: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const body = errorFromCause(cause);
    res.status(body.code).json(body);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地服务无端口");
  const origin = `http://127.0.0.1:${address.port}`;
  afterAll(async () => {
    stream.mockRestore();
    record.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const request = () => fetch(`${origin}/enhancePrompt`, {
    method: "POST", headers: { "Content-Type": "application/json", origin, "x-toonflow-workspace": "1" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
  });

  test("前置日志拒绝保持507且不调用模型", async () => {
    failKind = "promptRequested";
    const response = await request();
    expect(response.status).toBe(507);
    expect(stream).not.toHaveBeenCalled();
  });

  test("后置日志拒绝仍返回有效建议，并明确无需重复调用", async () => {
    failKind = "promptResult";
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data.status).toBe("enhanced");
    expect(body.data.enhancedPrompt).toBe("猫缓步走过庭院，镜头平稳跟随。");
    expect(body.data.activityWarning).toContain("日志未保存");
    expect(body.data.activityWarning).toContain("无需");
    expect(body.data.activityWarning).not.toContain("测试日志容量不足");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  test("澄清结果在日志失败后仍保留原文和问题", async () => {
    output = { status: "clarification", clarification: "希望镜头跟随还是固定？" };
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.status).toBe("clarification");
    expect(body.data.enhancedPrompt).toBe(input.prompt);
    expect(body.data.clarification).toBe("希望镜头跟随还是固定？");
    expect(body.data.activityWarning).toContain("日志未保存");
  });

  test("正常记录不产生失败警告", async () => {
    failKind = "";
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).data.activityWarning).toBeUndefined();
  });

  test("客户端拒绝非法或超长警告，有效警告与建议共同保留", async () => {
    const { enhanceVideoPrompt } = await import(Bun.resolveSync("@toonflow/node-shared/videoPromptAssistant", resolve(import.meta.dirname, "../../../packages/nodes/videoGenerationNode")));
    let activityWarning: unknown;
    const response = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ code: 200, data: {
      status: "enhanced", originalPrompt: input.prompt, enhancedPrompt: "猫缓步走过庭院，镜头平稳跟随。",
      changeSummary: "明确动作和镜头", strategyVersion: "videoPromptV2", activityWarning,
    } }));
    try {
      for (const invalid of [null, 12, { message: "不是字符串" }, "长".repeat(501)]) {
        activityWarning = invalid;
        await expect(enhanceVideoPrompt({ ...input, mode: "text" }, new AbortController().signal)).rejects.toThrow("响应无效");
      }
      activityWarning = "结果日志未保存，无需重复调用。";
      const result = await enhanceVideoPrompt({ ...input, mode: "text" }, new AbortController().signal);
      expect(result.activityWarning).toBe(activityWarning);
      expect(result.enhancedPrompt).toBe("猫缓步走过庭院，镜头平稳跟随。");
    } finally {
      response.mockRestore();
    }
  });
}
