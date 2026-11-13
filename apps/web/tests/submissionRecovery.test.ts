import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFile } from "@toonflow/file";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { createRequire } from "node:module";

const nodeJavascript = ts.transpileModule(await readFile(fileURLToPath(new URL("../../../packages/nodeScaffold/src/nodeAi.ts", import.meta.url)), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function createNodeRecovery(saved = new Map<string, string>(), outputPath = "assets/nodeOne/result.mp4") {
  const storage = { failWrite: false, failRemove: false,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem(key: string, value: string) { if (storage.failWrite) throw new Error("storage unavailable"); saved.set(key, value); },
    removeItem(key: string) { if (storage.failRemove) throw new Error("storage unavailable"); saved.delete(key); },
  };
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const state = { actor: null as string | null, role: "admin", projectId: undefined as string | undefined, status: "succeeded", billingState: "notSubmitted", fail: true, invalid: false, httpStatus: 200, canResume: false, resumeFail: false, resolveResult: undefined as any, onResponse: undefined as (() => void) | undefined };
  const input = { directory: "/synthetic/node", outputDirectory: "assets/nodeOne", providerId: "synthetic", modelId: "video", prompt: "private prompt" };
  const exports: any = {};
  new Function("require", "exports", "sessionStorage", "fetch", nodeJavascript)((name: string) => name === "vue" ? vue : {}, exports, storage,
    async (url: string, options: any = {}) => {
      const reply = (data: unknown) => Response.json({ code: 200, data });
      if (url === "/api/auth/status") return reply({ required: state.actor !== null });
      if (url === "/api/auth/session") return reply({ id: state.actor, role: state.role });
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body, headers: options.headers ?? {} });
      if (state.fail) throw new Error("connection lost");
      if (url.endsWith("/resolveSubmission")) return reply(state.resolveResult ?? { state: "closed", requestId: body.requestId, projectId: state.projectId, actorId: state.actor });
      if (url.endsWith("/resume") && state.resumeFail) throw new Error("resume lost");
      if (state.httpStatus !== 200) return Response.json({ code: state.httpStatus, message: "Task unavailable" }, { status: state.httpStatus });
      const id = body?.requestId ?? body?.id ?? new URL(url, "http://localhost").searchParams.get("id");
      const response = reply({ id: state.invalid ? "wrong" : id, mediaType: "video", projectId: state.projectId, canResume: state.canResume, status: url.endsWith("/resume") ? "succeeded" : state.status, billingState: state.billingState, createdBy: state.actor ? { id: state.actor } : undefined,
        files: [{ path: outputPath, mimeType: "video/mp4", mediaType: "video" }] });
      state.onResponse?.();
      return response;
    });
  const scope = vue.effectScope();
  const ai = scope.run(() => exports.useNodeAi("nodeOne", () => state.projectId));
  dispose.push(() => scope.stop());
  return { saved, storage, state, calls, ai, input, stop: () => scope.stop() };
}

type Request = { url: string; body: any; headers: Record<string, string>; resolve: (value: any) => void; reject: (cause: any) => void };
type State = { restored: vue.Ref<any>; pending: vue.Ref<any>; prompt: vue.Ref<string>; models: vue.Ref<any[]>; quota: vue.Ref<any>; loading: vue.Ref<boolean>; storageReady: vue.Ref<boolean>; errorMessage: vue.Ref<string>; submit: () => Promise<void>; queryTask: () => Promise<void>; resolveSubmission: () => Promise<void> };
const project = { id: "11111111-1111-4111-8111-111111111111", directory: "/synthetic/project" };
const record = { version: 1, projectId: project.id, directory: project.directory, requestId: "22222222-2222-4222-8222-222222222222" };
const storageKey = "toonflow.memberVideo.accountOne";
const filename = fileURLToPath(new URL("../src/pages/member/videoGeneration.vue", import.meta.url));
const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
const javascript = ts.transpileModule(compileScript(descriptor, { id: "submissionRecovery" }).content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const dispose: (() => void)[] = [];
const renderer = vue.createRenderer<object, object>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, insert() {}, remove() {}, patchProp() {} });
const success = (data: unknown, status = 200) => ({ status, data: { code: 200, data } });
const closed = () => success({ state: "closed", requestId: record.requestId, projectId: project.id, actorId: "accountOne" });
const task = (id = record.requestId) => ({ id, projectId: project.id, createdBy: { id: "accountOne", username: "member" } });
async function flush() { for (let index = 0; index < 8; index++) { await Promise.resolve(); await vue.nextTick(); } }

async function createPage(recovery = false, withProject = true, sharedStorage?: Map<string, string>) {
  const saved = sharedStorage ?? new Map<string, string>();
  if (recovery) saved.set(storageKey, JSON.stringify(record));
  const storage = { failWrite: false, failRemove: false,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem(key: string, value: string) { if (storage.failWrite) throw new Error("storage unavailable"); saved.set(key, value); },
    removeItem(key: string) { if (storage.failRemove) throw new Error("storage unavailable"); saved.delete(key); },
  };
  const account = { id: "accountOne" };
  const requests: Request[] = [], gets: string[] = [], submitted: string[] = [];
  const props = vue.reactive<{ project?: typeof project; modelValue: boolean }>({ project: withProject ? { ...project } : undefined, modelValue: true });
  function request(url: string, body: any, options: { headers?: Record<string, string> } = {}) {
    return new Promise((resolve, reject) => requests.push({ url, body: JSON.parse(JSON.stringify(body)), headers: options.headers ?? {}, resolve, reject }));
  }
  const axios = {
    get(url: string, options?: any) {
      gets.push(url);
      if (url === "/api/auth/session") return Promise.resolve(success({ id: account.id }));
      if (url.endsWith("/models")) return Promise.resolve(success([{ type: "video", providerId: "synthetic", modelId: "video", mode: ["text"], audio: false, durationResolutionMap: [{ duration: [4], resolution: ["720p"] }] }]));
      if (url.endsWith("/quota")) return Promise.resolve(success({ enabled: true, remaining: 10, limit: 10, used: 0, resetAt: 1 }));
      return request(url, options?.params, options);
    },
    post: request,
    isAxiosError: (error: any) => error?.isAxiosError === true,
  };
  const exports: Record<string, any> = {};
  new Function("require", "exports", "sessionStorage", javascript)((id: string) => {
    if (id === "vue") return vue;
    if (id === "axios") return axios;
    throw new Error(`Unexpected dependency: ${id}`);
  }, exports, storage);
  const component = exports.default;
  let state: State;
  const setup = component.setup;
  component.setup = (componentProps: unknown, context: unknown) => { state = setup(componentProps, context); return state; };
  component.render = () => null;
  const app = renderer.createApp({ render: () => vue.h(component, { ...props, onSubmitted: (id: string) => submitted.push(id), "onUpdate:modelValue": (value: boolean) => { props.modelValue = value; } }) });
  app.mount({});
  let mounted = true;
  const stop = () => { if (mounted) { app.unmount(); mounted = false; } };
  dispose.push(stop);
  await flush();
  return { state: state!, saved, storage, requests, gets, submitted, props, account, stop };
}
afterEach(() => { for (const stop of dispose.splice(0)) stop(); });

test("画布真实组件按素材联动模式，未知能力不产生生成输入", async () => {
  const { z } = createRequire(new URL("../../../packages/nodeScaffold/package.json", import.meta.url))("zod");
  const filename = fileURLToPath(new URL("../../../packages/nodes/videoGenerationNode/src/index.vue", import.meta.url));
  const descriptor = parse(await readFile(filename, "utf8"), { filename }).descriptor;
  const javascript = ts.transpileModule(compileScript(descriptor, { id: "videoParameters" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const model = { type: "video", providerId: "synthetic", modelId: "video", mode: ["text", "singleImage"], audio: false, durationResolutionMap: [{ duration: [6], resolution: ["720p"] }, { duration: [8], resolution: ["1080p"] }] };
  const node = vue.reactive({ data: { prompt: "synthetic prompt" } });
  const refs = vue.ref<any[]>([]);
  const exports: any = {};
  new Function("require", "exports", "window", javascript)((id: string) => {
    if (id === "vue") return vue;
    if (id === "element-plus") return { ElLoading: { directive: {} } };
    if (id === "@toonflow/nodes-scaffold/runtime") return { z, nodeTools: { register() {} }, useNode: () => ({ id: "synthetic", node, outputs: vue.ref({}), nodeEvent: { on() {} }, files: { useFileUrl: () => vue.ref("") }, ai: { getMediaModels: async () => [model] } }) };
    if (id.endsWith("/useNodeReferences")) return { useNodeReferences: () => ({ refList: refs, referenceMentions: vue.ref([]) }) };
    if (id.endsWith("/useNodeGeneration")) return { useNodeGeneration: () => ({ generating: vue.ref(false) }) };
    return {};
  }, exports, { addEventListener() {}, removeEventListener() {} });
  const component = exports.default;
  const setup = component.setup;
  let state: any;
  component.setup = (props: any, context: any) => state = setup(props, context);
  component.render = () => null;
  const app = renderer.createApp(component);
  app.mount({}); dispose.push(() => app.unmount()); await flush();
  expect(state.selectedMode.value).toBe("text");
  expect(state.generationDisabledReason.value).toBe("");
  expect(state.generationInput.value.duration).toBe(6);
  refs.value = [{ dataType: "IMAGE", value: { url: "sample.png", mimeType: "image/png" } }]; await flush();
  expect(state.selectedMode.value).toBe("singleImage");
  expect(state.generationInput.value.images).toHaveLength(1);
  refs.value.push({ dataType: "VIDEO", value: { url: "sample.mp4" } }); await flush();
  expect(state.generationDisabledReason.value).toContain("不匹配");
  expect(state.generationInput.value).toBeUndefined();
  refs.value = []; await flush();
  state.data.value.duration = 8; await flush();
  expect(state.data.value.resolution).toBe("1080p");
  state.models.value = [{ ...model, audio: undefined }]; await flush();
  expect(state.generationDisabledReason.value).toContain("音频能力");
  expect(state.generationInput.value).toBeUndefined();
});

test("生成参数随模型联动，保留有效选择并拒绝未知能力及非法组合", async () => {
  const page = await createPage();
  const state = page.state as any;
  const model = { ...state.models.value[0], durationResolutionMap: [{ duration: [6], resolution: ["720p"] }, { duration: [8], resolution: ["1080p"] }] };
  state.models.value = [model]; await flush();
  expect(state.duration.value).toBe(6);
  expect(state.resolution.value).toBe("720p");
  state.duration.value = 8; await flush();
  expect(state.resolution.value).toBe("1080p");
  state.models.value = [{ ...model, modelId: "another" }]; await flush();
  expect(state.duration.value).toBe(8);
  expect(state.parameterWarning.value).toBe("");
  state.prompt.value = "synthetic prompt";
  state.resolution.value = "720p";
  await state.submit();
  expect(state.errorMessage.value).toContain("时长与分辨率");
  expect(page.requests).toHaveLength(0);
  for (const [change, message] of [[{ audio: undefined }, "音频能力"], [{ mode: undefined }, "生成模式"], [{ mode: ["singleImage"] }, "仅支持文生视频"], [{ durationResolutionMap: [] }, "尚未配置"]] as const) {
    state.models.value = [{ ...model, ...change }]; await flush();
    expect(state.parameterWarning.value).toContain(message);
    await state.submit();
    expect(page.requests).toHaveLength(0);
    expect(page.saved.size).toBe(0);
  }
  expect(state.duration.value).toBeUndefined();
  expect(state.resolution.value).toBe("");
});

test("固定音频能力随所选模型提交，不使用旧开关值", async () => {
  for (const audio of [true, false]) {
    const page = await createPage();
    const state = page.state as any;
    state.models.value = [{ ...state.models.value[0], audio }]; await flush();
    state.generateAudio.value = !audio;
    state.prompt.value = "synthetic prompt";
    const operation = state.submit(); await flush();
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]!.body.generateAudio).toBe(audio);
    page.requests[0]!.resolve(success(task(page.requests[0]!.body.requestId), 202));
    await operation;
  }
});

test("存提醒后未POST即刷新：无父项目的旧version1恢复经closed解锁并重载模型额度", async () => {
  const page = await createPage(true, false);
  const operation = page.state.resolveSubmission(); await flush();
  expect(page.requests[0]!.url).toBe("/api/ai/media/tasks/resolveSubmission");
  expect(page.requests[0]!.body).toEqual({ directory: record.directory, requestId: record.requestId });
  page.requests[0]!.resolve(closed()); await operation; await flush();
  expect(page.saved.has(storageKey)).toBe(false);
  expect(page.state.restored.value).toBeUndefined();
  expect(page.state.models.value).toHaveLength(1);
  expect(page.state.quota.value.remaining).toBe(10);
  expect(page.state.loading.value).toBe(false);
  expect(page.props.modelValue).toBe(true);
  page.state.prompt.value = "fresh prompt";
  const submit = page.state.submit(); await flush();
  expect(page.requests[1]!.url).toBe("/api/ai/media/tasks/create");
  expect(page.requests[1]!.body.requestId).not.toBe(record.requestId);
  page.requests[1]!.resolve(success(task(page.requests[1]!.body.requestId), 202)); await submit;
});

test("POST响应丢失后核对existing仅打开原任务，不重复create也不把提示词存storage", async () => {
  const page = await createPage();
  page.state.prompt.value = "private prompt";
  const submit = page.state.submit(); await flush();
  const id = page.requests[0]!.body.requestId;
  expect(Object.keys(JSON.parse(page.saved.get(storageKey)!)).sort()).toEqual(["directory", "projectId", "requestId", "version"]);
  expect(page.saved.get(storageKey)).not.toContain("private prompt");
  page.requests[0]!.reject(new Error("response lost")); await submit;
  const resolve = page.state.resolveSubmission(); await flush();
  page.requests[1]!.resolve(success({ state: "existing", task: task(id) })); await resolve;
  expect(page.requests.filter(item => item.url.endsWith("/create"))).toHaveLength(1);
  expect(page.submitted).toEqual([project.id]);
  expect(page.saved.has(storageKey)).toBe(false);
});

test("恢复响应丢失并再次刷新后仍核对同一UUID", async () => {
  const page = await createPage(true);
  const first = page.state.resolveSubmission(); await flush();
  page.requests[0]!.reject(new Error("response lost")); await first;
  page.stop();
  const reopened = await createPage(false, false, page.saved);
  const second = reopened.state.resolveSubmission(); await flush();
  expect(reopened.requests[0]!.body.requestId).toBe(record.requestId);
  reopened.requests[0]!.resolve(closed()); await second; await flush();
  expect(reopened.saved.has(storageKey)).toBe(false);
  expect(reopened.state.models.value).toHaveLength(1);
});

test("清storage失败时保留提醒，禁止新提交且可同UUID重新核对", async () => {
  const page = await createPage(true);
  page.storage.failRemove = true;
  const first = page.state.resolveSubmission(); await flush();
  page.requests[0]!.resolve(closed()); await first;
  expect(page.state.restored.value.requestId).toBe(record.requestId);
  expect(page.saved.has(storageKey)).toBe(true);
  await page.state.submit();
  expect(page.requests).toHaveLength(1);
  page.storage.failRemove = false;
  const second = page.state.resolveSubmission(); await flush();
  expect(page.requests[1]!.body).toEqual(page.requests[0]!.body);
  page.requests[1]!.resolve(closed()); await second;
  expect(page.saved.has(storageKey)).toBe(false);
});

for (const status of [403, 404, 429, 503, 507]) {
  test(`核对返回${status}不得清除恢复提醒`, async () => {
    const page = await createPage(true);
    const operation = page.state.resolveSubmission(); await flush();
    page.requests[0]!.reject({ isAxiosError: true, message: "rejected", response: { status, data: { message: "rejected" } } });
    await operation;
    expect(page.saved.has(storageKey)).toBe(true);
    expect(page.state.restored.value.requestId).toBe(record.requestId);
  });
}

test("账号在核对期间变化不清除旧账号提醒", async () => {
  const page = await createPage(true);
  const operation = page.state.resolveSubmission(); await flush();
  page.account.id = "accountTwo";
  page.requests[0]!.resolve(closed()); await operation;
  expect(page.saved.has(storageKey)).toBe(true);
  expect(page.state.restored.value.requestId).toBe(record.requestId);
  expect(page.state.storageReady.value).toBe(false);
  expect(page.submitted).toEqual([]);
});

test("卸载与切换项目时迟到的核对响应不清除提醒", async () => {
  for (const unmount of [true, false]) {
    const page = await createPage(true);
    const operation = page.state.resolveSubmission(); await flush();
    if (unmount) page.stop(); else { page.props.project = { id: "33333333-3333-4333-8333-333333333333", directory: "/synthetic/other" }; await flush(); }
    page.requests[0]!.resolve(closed()); await operation;
    expect(page.saved.has(storageKey)).toBe(true);
    expect(page.submitted).toEqual([]);
  }
});

test("无效closed或existing三ID不匹配均保留提醒", async () => {
  for (const result of [{ state: "closed", requestId: record.requestId, projectId: project.id, actorId: "wrong" }, { state: "existing", task: task("wrong") }]) {
    const page = await createPage(true);
    const operation = page.state.resolveSubmission(); await flush();
    page.requests[0]!.resolve(success(result)); await operation;
    expect(page.saved.has(storageKey)).toBe(true);
    expect(page.submitted).toEqual([]);
  }
});

test("GET404保留提醒；GET成功也须在返回后确认账号", async () => {
  const page = await createPage(true);
  const first = page.state.queryTask(); await flush();
  page.requests[0]!.reject({ isAxiosError: true, response: { status: 404 } }); await first;
  expect(page.saved.has(storageKey)).toBe(true);
  const second = page.state.queryTask(); await flush();
  page.account.id = "accountTwo";
  page.requests[1]!.resolve(success(task())); await second;
  expect(page.saved.has(storageKey)).toBe(true);
  expect(page.submitted).toEqual([]);
});

test("存储写失败不发送create，重试同ID保持原参数", async () => {
  const page = await createPage();
  page.state.prompt.value = "first prompt";
  page.storage.failWrite = true;
  await page.state.submit();
  expect(page.requests).toHaveLength(0);
  const id = page.state.pending.value.body.requestId;
  page.storage.failWrite = false;
  page.state.prompt.value = "changed prompt";
  const submit = page.state.submit(); await flush();
  expect(page.requests[0]!.body.requestId).toBe(id);
  expect(page.requests[0]!.body.prompt).toBe("first prompt");
  page.requests[0]!.reject(new Error("response lost")); await submit;
});

test("create202错误任务或响应后换账号均不能误清提醒", async () => {
  for (const changeAccount of [true, false]) {
    const page = await createPage();
    page.state.prompt.value = "prompt";
    const operation = page.state.submit(); await flush();
    if (changeAccount) page.account.id = "accountTwo";
    page.requests[0]!.resolve(success(task(changeAccount ? page.requests[0]!.body.requestId : "wrong"), 202)); await operation;
    expect(page.saved.has(storageKey)).toBe(true);
    expect(page.submitted).toEqual([]);
  }
});

test("关闭重开弹窗保留旧UUID并允许再次核对，旧响应不解锁", async () => {
  const page = await createPage(true);
  const first = page.state.resolveSubmission(); await flush();
  page.props.modelValue = false; await flush();
  page.props.modelValue = true; await flush();
  page.requests[0]!.resolve(closed()); await first;
  expect(page.saved.has(storageKey)).toBe(true);
  const second = page.state.resolveSubmission(); await flush();
  expect(page.requests[1]!.body).toEqual(page.requests[0]!.body);
  page.requests[1]!.resolve(closed()); await second; await flush();
  expect(page.state.models.value).toHaveLength(1);
  expect(page.state.loading.value).toBe(false);
});

test("create进行中卸载，迟到202不清提醒也不通知父页", async () => {
  const page = await createPage();
  page.state.prompt.value = "prompt";
  const submit = page.state.submit(); await flush();
  const id = page.requests[0]!.body.requestId;
  page.stop();
  page.requests[0]!.resolve(success(task(id), 202)); await submit;
  expect(page.saved.has(storageKey)).toBe(true);
  expect(page.submitted).toEqual([]);
});

test("pending经closed解除后同弹窗可编辑，重新加载模型额度", async () => {
  const page = await createPage();
  page.state.prompt.value = "prompt";
  const submit = page.state.submit(); await flush();
  const id = page.requests[0]!.body.requestId;
  page.requests[0]!.reject(new Error("response lost")); await submit;
  const modelsBefore = page.gets.filter(url => url.endsWith("/models")).length;
  const resolve = page.state.resolveSubmission(); await flush();
  page.requests[1]!.resolve(success({ state: "closed", requestId: id, projectId: project.id, actorId: "accountOne" })); await resolve; await flush();
  expect(page.state.pending.value).toBeUndefined();
  expect(page.gets.filter(url => url.endsWith("/models")).length).toBe(modelsBefore + 1);
  expect(page.state.quota.value.remaining).toBe(10);
  expect(page.state.prompt.value).toBe("prompt");
  expect(page.state.loading.value).toBe(false);
});

test("existing结果已确认但清storage失败仍保留提醒且不打开任务", async () => {
  const page = await createPage(true);
  page.storage.failRemove = true;
  const first = page.state.resolveSubmission(); await flush();
  page.requests[0]!.resolve(success({ state: "existing", task: task() })); await first;
  expect(page.saved.has(storageKey)).toBe(true);
  expect(page.submitted).toEqual([]);
  page.storage.failRemove = false;
  const second = page.state.resolveSubmission(); await flush();
  page.requests[1]!.resolve(success({ state: "existing", task: task() })); await second;
  expect(page.submitted).toEqual([project.id]);
});

test("节点断线刷新后仅GET原UUID，存储不包含提示词，成功终态才解锁", async () => {
  const node = createNodeRecovery();
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow("恢复原任务");
  const id = node.calls[0]!.body.requestId;
  expect([...node.saved.values()].join()).not.toContain("private prompt");
  node.stop();
  const restored = createNodeRecovery(node.saved);
  restored.state.fail = false;
  expect(await restored.ai.generateVideo(restored.input)).toHaveLength(1);
  expect(restored.calls).toHaveLength(1);
  expect(restored.calls[0]!.url).toContain(`/get?directory=%2Fsynthetic%2Fnode&id=${id}`);
  expect(restored.saved.size).toBe(0);
});

test("节点接收规范化输出目录，刷新恢复仅核对原ID且成功解除提醒", async () => {
  for (const [outputDirectory, outputPath] of [[".", "result.mp4"], ["./", "result.mp4"], [".", "assets/nodeOne/result.mp4"], ["assets/nodeOne/", "assets/nodeOne/result.mp4"], ["./assets//nodeOne/.", "assets/nodeOne/result.mp4"], ["assets\\nodeOne\\", "assets/nodeOne/result.mp4"]]) {
    const node = createNodeRecovery(undefined, outputPath);
    node.input.outputDirectory = outputDirectory;
    await expect(node.ai.generateVideo(node.input)).rejects.toThrow("恢复原任务");
    const id = node.calls[0]!.body.requestId;
    node.stop();
    const restored = createNodeRecovery(node.saved, outputPath);
    restored.state.fail = false;
    expect(await restored.ai.recoverMedia(restored.input.directory)).toEqual({ state: "succeeded", files: [{ path: outputPath, mimeType: "video/mp4", mediaType: "video" }] });
    expect(restored.calls).toHaveLength(1);
    expect(restored.calls[0]!.url).toContain(id);
    expect(restored.saved.size).toBe(0);
    const fresh = createNodeRecovery(undefined, outputPath);
    fresh.input.outputDirectory = outputDirectory;
    fresh.state.fail = false;
    expect(await fresh.ai.generateVideo(fresh.input)).toHaveLength(1);
    expect(fresh.saved.size).toBe(0);
    expect(fresh.calls).toHaveLength(1);
  }
});

test("节点拒绝越界或非规范输出路径，保留原ID且不重复提交", async () => {
  for (const outputDirectory of [".", "assets/nodeOne/"]) {
    for (const outputPath of ["../result.mp4", "/result.mp4", "assets/nodeOne/../result.mp4", "assets/nodeOne/./result.mp4", "assets/nodeOne//result.mp4", "assets/nodeOne/", "C:/result.mp4", "assets\\nodeOne\\result.mp4", ...(outputDirectory === "." ? [] : ["assets/nodeOneOther/result.mp4"])]) {
      const node = createNodeRecovery(undefined, outputPath);
      node.input.outputDirectory = outputDirectory;
      node.state.fail = false;
      await expect(node.ai.generateVideo(node.input)).rejects.toThrow("输出无效");
      await expect(node.ai.recoverMedia(node.input.directory)).rejects.toThrow("输出无效");
      expect(node.saved.size).toBe(1);
      expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(1);
    }
  }
});

test("节点未知响应、错误ID及清标记失败都不允许新POST", async () => {
  const node = createNodeRecovery();
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  node.state.fail = false;
  node.state.httpStatus = 404;
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow("Task unavailable");
  node.state.httpStatus = 200;
  node.state.invalid = true;
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow("响应不匹配");
  node.state.invalid = false;
  node.storage.failRemove = true;
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  expect(node.saved.size).toBe(1);
  expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(1);
  node.storage.failRemove = false;
  await node.ai.generateVideo(node.input);
  expect(node.saved.size).toBe(0);
});

test("节点存储失败拒绝提交，账号变化保留原任务", async () => {
  const node = createNodeRecovery();
  node.storage.failWrite = true;
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow("未提交新任务");
  expect(node.calls).toHaveLength(0);
  node.storage.failWrite = false;
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  node.state.actor = "other";
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow("其他登录状态");
  expect(node.calls).toHaveLength(1);
  expect(node.saved.size).toBe(1);
});

test("节点更改参数仅核对旧任务，不把旧输出当新结果；明确失败后可新提交", async () => {
  const node = createNodeRecovery();
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  node.state.fail = false;
  await expect(node.ai.generateVideo({ ...node.input, prompt: "different" })).rejects.toThrow("当前参数已改变");
  expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(1);
  expect(node.saved.size).toBe(0);
  node.state.status = "failed";
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow("生成未完成");
  expect(node.saved.size).toBe(0);
  expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(2);
});

test("同槽并发实例仅有一次create，卸载不删除未知任务", async () => {
  const first = createNodeRecovery();
  const second = createNodeRecovery(first.saved);
  await Promise.allSettled([first.ai.generateVideo(first.input), second.ai.generateVideo(second.input)]);
  expect([...first.calls, ...second.calls].filter(call => call.url.endsWith("/create"))).toHaveLength(1);
  expect(first.saved.size).toBe(1);
  first.stop(); second.stop();
  expect(first.saved.size).toBe(1);
});

test("节点重启中断或取消但供应商费用未知，持续GET原ID且不解锁", async () => {
  const node = createNodeRecovery();
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  node.state.fail = false;
  node.state.billingState = "unknown";
  for (const status of ["interrupted", "cancelled", "failed"]) {
    node.state.status = status;
    await expect(node.ai.generateVideo(node.input)).rejects.toThrow("不会新建任务");
    expect(node.saved.size).toBe(1);
  }
  expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(1);
});

test("节点响应迟到时卸载或账号变化都不交付输出且保留UUID", async () => {
  for (const changeAccount of [false, true]) {
    const node = createNodeRecovery();
    node.state.fail = false;
    node.state.onResponse = () => { if (changeAccount) node.state.actor = "other"; else node.stop(); };
    await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
    expect(node.saved.size).toBe(1);
    expect(node.calls).toHaveLength(1);
  }
});

test("独立恢复不依赖提示词模型，empty零请求，成功仅取原输出", async () => {
  const node = createNodeRecovery();
  expect(await node.ai.recoverMedia(node.input.directory)).toEqual({ state: "empty" });
  expect(node.calls).toHaveLength(0);
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  node.state.fail = false;
  const result = await node.ai.recoverMedia(node.input.directory);
  expect(result.state).toBe("succeeded");
  expect(result.files[0].path).toBe("assets/nodeOne/result.mp4");
  expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(1);
});

test("已登录项目404经持久closed解锁，错误三ID和清存储失败保留", async () => {
  const node = createNodeRecovery();
  node.state.actor = "owner"; node.state.projectId = "project";
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  const id = node.calls[0]!.body.requestId;
  node.state.fail = false; node.state.httpStatus = 404;
  for (const field of ["requestId", "projectId", "actorId"]) {
    node.state.resolveResult = { state: "closed", requestId: id, projectId: "project", actorId: "owner", [field]: "wrong" };
    await expect(node.ai.recoverMedia(node.input.directory)).rejects.toThrow("响应不匹配");
    expect(node.saved.size).toBe(1);
  }
  node.state.resolveResult = undefined; node.storage.failRemove = true;
  await expect(node.ai.recoverMedia(node.input.directory)).rejects.toThrow();
  expect(node.saved.size).toBe(1);
  node.storage.failRemove = false;
  expect(await node.ai.recoverMedia(node.input.directory)).toEqual({ state: "closed" });
  expect(node.saved.size).toBe(0);
  expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(1);
});

test("匿名404与项目切换保留提醒，不调用关闭", async () => {
  const node = createNodeRecovery();
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  node.state.fail = false; node.state.httpStatus = 404;
  await expect(node.ai.recoverMedia(node.input.directory)).rejects.toThrow("无法安全关闭");
  expect(node.calls.filter(call => call.url.endsWith("/resolveSubmission"))).toHaveLength(0);
  node.state.httpStatus = 200;
  node.state.onResponse = () => { node.state.projectId = "changed"; };
  await expect(node.ai.recoverMedia(node.input.directory)).rejects.toThrow("项目已变化");
  expect(node.saved.size).toBe(1);
});

test("显式恢复可续查原视频，失败保留，同槽并发只一次resume，普通生成不自动续查", async () => {
  const node = createNodeRecovery();
  node.state.actor = "admin";
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  node.state.fail = false; node.state.status = "interrupted"; node.state.billingState = "unknown"; node.state.canResume = true;
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow("不会新建任务");
  expect(node.calls.filter(call => call.url.endsWith("/resume"))).toHaveLength(0);
  node.state.resumeFail = true;
  await expect(node.ai.recoverMedia(node.input.directory)).rejects.toThrow("resume lost");
  expect(node.saved.size).toBe(1);
  node.state.resumeFail = false;
  const before = node.calls.length;
  const results = await Promise.allSettled([node.ai.recoverMedia(node.input.directory), node.ai.recoverMedia(node.input.directory)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(node.calls.slice(before).filter(call => call.url.endsWith("/resume"))).toHaveLength(1);
  expect(node.saved.size).toBe(0);
  expect(node.calls.filter(call => call.url.endsWith("/create"))).toHaveLength(1);
});

test("本地残留projectId不发送认证项目头、不自动resume", async () => {
  const node = createNodeRecovery();
  node.state.projectId = "old-project";
  await expect(node.ai.generateVideo(node.input)).rejects.toThrow();
  expect(node.calls[0]!.headers["x-toonflow-project-id"]).toBeUndefined();
  node.state.fail = false; node.state.canResume = true; node.state.status = "interrupted"; node.state.billingState = "unknown";
  await expect(node.ai.recoverMedia(node.input.directory)).rejects.toThrow("不会新建任务");
  expect(node.calls.filter(call => call.url.endsWith("/resume"))).toHaveLength(0);
  expect(node.saved.size).toBe(1);
});

test("共享模型读取独立超时后可重试，单节点取消不影响其他等待者", async () => {
  for (const type of ["language", "media"]) {
    const exports: any = {};
    const deadlines: AbortController[] = [];
    const timeouts: number[] = [];
    const calls: { url: string; signal?: AbortSignal }[] = [];
    const models = [{ providerId: "local", modelId: "synthetic", type: "video" }];
    new Function("require", "exports", "fetch", "AbortSignal", nodeJavascript)((name: string) => name === "vue" ? vue : {}, exports,
      (url: string, options: { signal?: AbortSignal }) => {
        calls.push({ url, signal: options.signal });
        if (calls.length > 1) return Promise.resolve(Response.json({ code: 200, data: models }));
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
        });
      }, { any: AbortSignal.any.bind(AbortSignal), timeout: (milliseconds: number) => {
        timeouts.push(milliseconds);
        const deadline = new AbortController(); deadlines.push(deadline);
        return deadline.signal;
      } });
    exports.invalidateNodeModels(type);
    const scope = vue.effectScope();
    try {
      const ai = scope.run(() => exports.useNodeAi("modelsOnly"));
      const read = type === "language" ? ai.getModels : ai.getMediaModels;
      const stopped = new AbortController();
      const first = read(stopped.signal);
      const second = read();
      void first.catch(() => {}); void second.catch(() => {});
      expect(calls).toHaveLength(1);
      expect(timeouts).toEqual([20000]);
      const deadline = deadlines[0]!;
      expect(calls[0]!.signal).toBe(deadline.signal);
      stopped.abort(new Error("stop one node"));
      await expect(first).rejects.toThrow("stop one node");
      expect(deadline.signal.aborted).toBe(false);
      deadline.abort(new DOMException("model read timed out", "TimeoutError"));
      await expect(second).rejects.toThrow("model read timed out");
      expect(await read()).toEqual(models);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.signal?.aborted).toBe(false);
      expect(await read()).toEqual(models);
      expect(calls).toHaveLength(2);
    } finally { scope.stop(); exports.invalidateNodeModels(type); }
  }
});

test("工作区目录等待透传停止与超时信号，真实generation run解除运行状态且未执行后续生成", async () => {
  const workspaceCode = ts.transpileModule(await readFile(fileURLToPath(new URL("../src/lib/workspaceFiles.ts", import.meta.url)), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const generationCode = ts.transpileModule(await readFile(fileURLToPath(new URL("../../../packages/nodeShared/src/useNodeGeneration.ts", import.meta.url)), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let observed: AbortSignal | undefined;
  const workspaceExports: any = {}, generationExports: any = {};
  new Function("require", "exports", workspaceCode)((name: string) => {
    if (name === "vue") return vue;
    if (name === "axios") return { create: () => ({ get(_url: string, options: { signal: AbortSignal }) {
      observed = options.signal;
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    } }) };
    if (name === "@/lib/i18n") return { registerApiLanguage() {} };
    return {};
  }, workspaceExports);
  const generationTools: any[] = [];
  new Function("require", "exports", generationCode)((name: string) => name === "vue" ? vue : { nodeTools: { register(tool: any) { generationTools.push(tool); } }, z: { strictObject: () => ({}) } }, generationExports);
  const recovered = generationExports.useNodeGeneration(vue.ref({}), () => {});
  expect(await recovered.run(async () => ({ state: "closed" }), (result: any) => result.state === "succeeded")).toEqual({ state: "closed" });
  expect(recovered.generating.value).toBe(false);
  expect(generationTools.find(tool => tool.name === "getGenerationStatus").execute().status).toBe("idle");
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout ? 10 : 20000)]);
    const state = generationExports.useNodeGeneration(vue.ref({}), () => controller.abort());
    let generated = false;
    const running = state.run(async () => {
      await workspaceExports.default("/synthetic/node").list("", signal);
      generated = true;
    });
    expect(state.generating.value).toBe(true);
    expect(observed).toBe(signal);
    if (!timeout) controller.abort();
    await expect(running).rejects.toThrow();
    expect(state.generating.value).toBe(false);
    expect(generated).toBe(false);
  }
});
