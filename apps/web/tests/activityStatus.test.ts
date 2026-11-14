import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFile } from "@toonflow/file";
import * as vue from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";
import ts from "typescript";
import daochengLanguage from "@toonflow/providers/language/daochengCloud";

type HostNode = { text: string; props: Record<string, unknown>; children: HostNode[]; parent: HostNode | null };
type Pending = { signal: AbortSignal; headers: Record<string, string>; resolve: (value: unknown) => void; reject: (error: Error) => void };
const filename = fileURLToPath(new URL("../src/pages/workspace/components/mediaTasks.vue", import.meta.url));
const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
const script = compileScript(descriptor, { id: "activityStatus" });
const template = compileTemplate({ source: descriptor.template!.content, filename, id: "activityStatus", compilerOptions: { bindingMetadata: script.bindings } });
const costFilename = fileURLToPath(new URL("../src/pages/workspace/components/mediaTaskCost.vue", import.meta.url));
const costDescriptor = parse(await readFile(costFilename, "utf8"), { filename: costFilename }).descriptor;
const costScript = compileScript(costDescriptor, { id: "costRecord" });
const costTemplate = compileTemplate({ source: costDescriptor.template!.content, filename: costFilename, id: "costRecord", compilerOptions: { bindingMetadata: costScript.bindings } });
const dispose: (() => void)[] = [];
const node = (text = ""): HostNode => ({ text, props: {}, children: [], parent: null });
const renderer = vue.createRenderer<HostNode, HostNode>({
  createElement: () => node(), createText: node, createComment: () => node(),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insert(target, parent, anchor) {
    target.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target);
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); },
  patchProp: (target, key, _previous, value) => { target.props[key] = value; },
});

function createPage(role: "admin" | "user" = "admin", required = true, cost = false, listRequest?: () => Promise<unknown>) {
  const requests: Pending[] = [];
  const actions: (Pending & { url: string; body: any })[] = [];
  const errors: string[] = [];
  const saved: { content: Blob; name: string }[] = [];
  const fileRequests: { signal: AbortSignal; resolve: (value: any) => void }[] = [];
  const records: (Pending & { body: any })[] = [], writes: (Pending & { body: any })[] = [];
  const confirmations: { message: string; resolve: () => void; reject: (cause: unknown) => void }[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const userRole = vue.ref(role), authRequired = vue.ref(required);
  const workspace = vue.reactive({ project: { directory: "/synthetic/project", serverProjectId: "one" } });
  const modelValue = vue.ref(true);
  const axios = {
    get(url: string, options: { signal: AbortSignal; headers: Record<string, string>; params?: unknown }) {
      if (url === "/api/activity/status") return new Promise((resolve, reject) => requests.push({ ...options, resolve, reject }));
      if (url === "/api/ai/media/tasks/list" && listRequest) return listRequest();
      if (url === "/api/ai/media/tasks/list") return Promise.resolve({ data: { code: 200, data: { tasks: [], total: 0, corruptCount: 0, corruptTaskIds: [] } } });
      if (url === "/api/activity/export" || url === "/api/ai/media/tasks/get" || url === "/api/ai/media/tasks/costHistory") return new Promise((resolve, reject) => records.push({ ...options, body: options.params, resolve, reject }));
      throw new Error(`Unexpected HTTP request: ${url}`);
    },
    post(url: string, body: unknown, options: { signal: AbortSignal; headers: Record<string, string> }) {
      return new Promise((resolve, reject) => actions.push({ ...options, url, body, resolve, reject }));
    },
    put(_url: string, body: unknown, options: { signal: AbortSignal; headers: Record<string, string> }) {
      return new Promise((resolve, reject) => writes.push({ ...options, body, resolve, reject }));
    },
    isAxiosError: (error: unknown) => !!error && typeof error === "object" && "response" in error,
  };
  const require = (id: string) => {
    if (id === "vue") return vue;
    if (id === "axios") return axios;
    if (id === "element-plus") return { ElMessage: { error(message: string) { errors.push(message); } }, ElMessageBox: { confirm: (message: string) => new Promise<void>((resolve, reject) => confirmations.push({ message, resolve, reject })) } };
    if (id === "@/stores/workspace") return { useWorkspaceStore: () => workspace };
    if (id === "@/lib/auth") return { userRole, authRequired };
    if (id === "@/lib/workspaceFiles") return () => ({
      read: (_path: string, options: { signal: AbortSignal }) => new Promise(resolve => fileRequests.push({ ...options, resolve })),
      acquireUrl: (_path: string, _mime: string, options: { signal: AbortSignal }) => ({ url: new Promise(resolve => fileRequests.push({ ...options, resolve })), release() {} }),
    });
    if (id === "@/lib/saveFile") return async (content: Blob | (() => Promise<Blob>), name: string) => { const value = typeof content === "function" ? await content() : content; saved.push({ content: value, name }); return true; };
    if (id.endsWith(".vue")) return { render: () => null };
    throw new Error(`Unexpected component dependency: ${id}`);
  };
  function evaluate(source: string) {
    const exports: Record<string, any> = {};
    const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function("require", "exports", "setInterval", "clearInterval", javascript)(require, exports,
      (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, (id: number) => timers.delete(id));
    return exports;
  }
  const component = evaluate(cost ? costScript.content : script.content).default;
  component.render = evaluate(cost ? costTemplate.code : template.code).render;
  let state: any;
  const setup = component.setup;
  component.setup = (props: unknown, context: unknown) => { state = setup(props, context); return state; };
  const app = renderer.createApp({ render: () => vue.h(component, { modelValue: modelValue.value, ...(cost ? { directory: workspace.project.directory, projectId: workspace.project.serverProjectId, taskId: "taskOne" } : {}) }) });
  const slot = { setup: (_props: unknown, context: { slots: Record<string, (() => unknown) | undefined> }) => () => vue.h("div", context.slots.default?.()) };
  for (const name of ["el-drawer", "el-date-picker", "el-button", "el-select", "el-option", "el-dialog", "el-form", "el-form-item", "el-radio-group", "el-radio", "el-input", "el-collapse", "el-collapse-item"]) app.component(name, slot);
  const root = node();
  app.mount(root);
  let mounted = true;
  const stop = () => { if (mounted) { app.unmount(); mounted = false; } };
  dispose.push(stop);
  const text = (target: HostNode): string => target.text + target.children.map(text).join("");
  const alerts = (target: HostNode): string[] => [...(target.props.role === "alert" ? [text(target)] : []), ...target.children.flatMap(alerts)];
  return { requests, records, writes, actions, errors, saved, fileRequests, confirmations, stop, get state() { return state; }, userRole, modelValue, workspace, timers, reload: () => state!.load(), text: () => text(root), alerts: () => alerts(root) };
}

const healthy = { bytes: 1048576, files: 4, limits: { maxBytes: 10485760, maxFiles: 100, maxRecordBytes: 1000, minFreeBytes: 1000 }, availableBytes: 1000000, blocked: false, reason: null as string | null, rejected: 2, lastRejectedAt: 1, lastScannedAt: 2, lastRejectedReason: null as string | null };

test("当日日志导出保留成功内容、日期文件名及失败后重试", async () => {
  const page = createPage();
  page.state.activityDay.value = "2026-11-13";
  const failed = page.state.exportActivity();
  page.records[0]!.reject(new Error("导出失败")); await failed;
  expect(page.errors).toEqual(["导出失败"]);
  expect(page.state.exportingActivity.value).toBe(false);
  const exporting = page.state.exportActivity();
  expect(page.records[1]!.body).toEqual({ day: "2026-11-13" });
  const content = { events: [{ stage: "succeeded" }] };
  page.records[1]!.resolve({ data: { code: 200, data: content } }); await exporting;
  expect(page.saved).toHaveLength(1);
  expect(page.saved[0]!.name).toBe("activity20261113.json");
  expect(JSON.parse(await page.saved[0]!.content.text())).toEqual(content);
  expect(page.state.exportingActivity.value).toBe(false);
});

for (const change of ["关闭", "切换项目", "降权", "修改日期", "卸载"] as const) {
  test(`当日日志导出在${change}后丢弃迟到成功与失败响应`, async () => {
    for (const failed of [false, true]) {
      const page = createPage();
      const exporting = page.state.exportActivity();
      const request = page.records[0]!;
      if (change === "关闭") page.modelValue.value = false;
      if (change === "切换项目") page.workspace.project = { directory: "/synthetic/other", serverProjectId: "two" };
      if (change === "降权") page.userRole.value = "user";
      if (change === "修改日期") page.state.activityDay.value = "2026-01-01";
      if (change === "卸载") page.stop();
      await flush();
      if (failed) request.reject(new Error("迟到错误"));
      else request.resolve({ data: { code: 200, data: { events: [] } } });
      await exporting;
      expect(page.saved).toHaveLength(0);
      expect(page.errors).toHaveLength(0);
      expect(request.signal?.aborted).toBe(true);
      expect(page.state.exportingActivity.value).toBe(false);
    }
  });
}

test("当日日志导出取消后可重新开始，旧请求结束不解除新请求忙状态", async () => {
  const page = createPage();
  const previous = page.state.exportActivity();
  page.state.activityDay.value = "2026-01-01";
  const current = page.state.exportActivity();
  expect(page.records).toHaveLength(2);
  page.records[0]!.resolve({ data: { code: 200, data: { stale: true } } }); await previous;
  expect(page.state.exportingActivity.value).toBe(true);
  expect(page.saved).toHaveLength(0);
  page.records[1]!.resolve({ data: { code: 200, data: { current: true } } }); await current;
  expect(page.saved).toHaveLength(1);
  expect(page.saved[0]!.name).toBe("activity20260101.json");
  expect(page.state.exportingActivity.value).toBe(false);
});

test("成员及关闭后的面板不能启动当日日志导出", async () => {
  const page = createPage("user");
  void page.state.exportActivity();
  expect(page.records).toHaveLength(0);
  page.userRole.value = "admin";
  page.modelValue.value = false; await flush();
  void page.state.exportActivity();
  expect(page.records).toHaveLength(0);
});

test("平台卡片仅显示本地配置与分类数量，不回显密钥或自动展开账户", async () => {
  const page = await createMediaSettingsPage();
  page.requests[0]!.resolve({ data: { code: 200, data: [page.provider] } }); await flush();
  expect(page.text()).toContain("配置连接与模型");
  expect(page.text()).toContain("API Key 已填写 · 连接未验证");
  expect(page.text()).toContain("图片 1 · 视频 1 · 音频 1 · 文本 0");
  expect(page.text()).not.toContain("secret-not-for-display");
  expect(page.accounts()).toBe(0);
  expect(page.calls).toEqual(["/api/providers/media/list"]);
  page.settings.value.mediaProviderConfigs.tfRouter.apiKey = " "; await flush();
  expect(page.text()).toContain("未填写 API Key");
  page.state.accountVisible.value = true; await flush();
  expect(page.accounts()).toBe(1);
});

test("平台列表加载失败持续显示重试提示，成功重新加载才解除", async () => {
  const page = await createMediaSettingsPage();
  page.requests[0]!.reject(new Error("secret-url")); await flush();
  expect(page.text()).toContain("当前无法确认已接入的平台");
  expect(page.text()).not.toContain("secret-url");
  const reload = page.state.loadProviders();
  expect(page.state.loadError.value).not.toBe("");
  page.requests[1]!.resolve({ data: { code: 200, data: [page.provider] } }); await reload; await flush();
  expect(page.text()).not.toContain("当前无法确认已接入的平台");
  expect(page.text()).toContain("Synthetic");
});

test("模型搜索保留原索引，过滤后编辑与删除只影响命中模型", async () => {
  const page = await createMediaSettingsPage(true);
  page.state.modelSearch.value = "VIDEO"; await flush();
  expect(page.state.filteredModels.value.map((entry: any) => entry.index)).toEqual([2]);
  expect(page.text()).toContain("Target Video");
  expect(page.text()).not.toContain("Second");
  page.click("编辑模型 Target Video"); await flush();
  expect(page.state.editingModelIndex.value).toBe(2);
  page.state.confirmModel({ id: "video-three", label: "Edited", type: "video" }); await flush();
  expect(page.state.models.value[0].id).toBe("image-one");
  expect(page.state.models.value[2].label).toBe("Edited");
  page.click("删除模型 Edited"); await flush();
  expect(page.state.models.value.map((model: any) => model.id)).toEqual(["image-one", "audio-two"]);
  expect(page.text()).toContain("没有匹配的模型");
  page.state.modelSearch.value = "音频"; await flush();
  expect(page.state.filteredModels.value[0].item.id).toBe("audio-two");
});

test("过滤模型后保存仍包含全部模型，不把搜索结果覆盖原配置", async () => {
  const page = await createMediaSettingsPage(true);
  page.state.modelSearch.value = "video";
  page.state.formApi.value = { validate: async () => {}, formData: () => ({ apiKey: "synthetic-key" }) };
  const saving = page.state.saveModels(); await flush();
  expect(page.writes[0].models.map((model: any) => model.id)).toEqual(["image-one", "audio-two", "video-three"]);
  page.requests[0]!.resolve({ data: { code: 200, data: [page.provider] } });
  await saving;
});

test("设置入口真实watch在打开和重新打开时定位指定模型分类", async () => {
  const filename = fileURLToPath(new URL("../src/components/settings/index.vue", import.meta.url));
  const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
  const compiled = compileScript(descriptor, { id: "settingsNavigation" });
  const exports: any = {};
  const code = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", code)((name: string) => name === "vue" ? { ...vue, defineAsyncComponent: () => ({ render: () => null }) } : {}, exports);
  const component = exports.default;
  const props = vue.reactive({ modelValue: false, initialPanel: "mediaModel" });
  let state: any;
  const setup = component.setup;
  component.setup = (values: unknown, context: unknown) => { state = setup(values, context); return state; };
  component.render = () => null;
  const app = renderer.createApp({ render: () => vue.h(component, props) });
  app.mount(node()); dispose.push(() => app.unmount());
  expect(state.activePanel.value.id).toBe("ui");
  props.modelValue = true; await flush();
  expect(state.activePanel.value.id).toBe("mediaModel");
  state.activePanel.value = state.settingsPanels[0];
  props.modelValue = false; await flush();
  props.modelValue = true; await flush();
  expect(state.activePanel.value.id).toBe("mediaModel");
  props.initialPanel = "languageModel"; await flush();
  expect(state.activePanel.value.id).toBe("languageModel");
});

test("文本模型列表读取成功不覆盖旧模型，明确未验证调用并提示未返回项", async () => {
  const page = await createMediaSettingsPage("language");
  page.state.providerForm.value = { validateField: async () => true };
  const fetching = page.state.fetchModels(); await flush();
  page.requests[0]!.resolve({ data: { code: 200, data: [{ id: "current-text-model", label: "Current" }] } });
  await fetching; await flush();
  expect(page.text()).toContain("已携带 API Key 读取列表成功");
  expect(page.text()).toContain("不代表模型调用成功");
  expect(page.text()).toContain("当前配置的部分模型本次未返回");
  expect(page.text()).toContain("old-saved-model");
  expect(page.state.models.value.map((model: any) => model.id)).toEqual(["old-saved-model"]);
  expect(page.state.selectedIds.value.size).toBe(0);
  page.state.selectedIds.value.add("current-text-model"); page.state.addSelectedModels();
  expect(page.state.models.value.map((model: any) => model.id)).toEqual(["old-saved-model", "current-text-model"]);
  page.state.models.value[0].id = " current-text-model "; await flush();
  expect(page.state.missingSavedModels.value).toEqual([]);
  page.state.models.value[0].id = "CURRENT-TEXT-MODEL"; await flush();
  expect(page.state.missingSavedModels.value.map((model: any) => model.id)).toEqual(["CURRENT-TEXT-MODEL"]);
  page.state.models.value.splice(0, 1); await flush();
  expect(page.text()).not.toContain("当前配置的部分模型本次未返回");
  expect(page.calls).toEqual(["/api/providers/models"]);
  expect(page.writes).toHaveLength(0);
});

test("文本发现空列表明确提示且保留旧项，参数变化清旧结论并拒绝迟到响应", async () => {
  const page = await createMediaSettingsPage("language");
  page.state.providerForm.value = { validateField: async () => true };
  let fetching = page.state.fetchModels(); await flush();
  page.requests[0]!.resolve({ data: { code: 200, data: [] } }); await fetching; await flush();
  expect(page.text()).toContain("本次未返回文本模型");
  expect(page.state.models.value[0].id).toBe("old-saved-model");
  fetching = page.state.fetchModels(); await flush();
  page.state.form.apiUrl = "https://other.invalid/v1";
  expect(page.requests[1]!.signal!.aborted).toBe(true);
  const newer = page.state.fetchModels(); await flush();
  page.requests[1]!.resolve({ data: { code: 200, data: [{ id: "stale", label: "Stale" }] } }); await fetching;
  expect(page.state.fetching.value).toBe(true);
  expect(page.state.discoveryComplete.value).toBe(false);
  page.requests[2]!.resolve({ data: { code: 200, data: [{ id: "latest", label: "Latest" }] } }); await newer; await flush();
  expect(page.state.fetchedModels.value.map((model: any) => model.id)).toEqual(["latest"]);
  page.state.form.apiKey = "changed"; await flush();
  expect(page.state.discoveryComplete.value).toBe(false);
  expect(page.state.resultsVisible.value).toBe(false);
  expect(page.text()).not.toContain("已携带 API Key 读取列表成功");
});

test("媒体刷新部分导入或全部跳过展示真实统计和模型ID，不宣称全部更新成功", async () => {
  const page = await createMediaSettingsPage();
  page.requests[0]!.resolve({ data: { code: 200, data: [page.provider] } }); await flush();
  for (const imported of [2, 0]) {
    const request = page.state.fetchModels(page.provider); await flush();
    page.requests.at(-1)!.resolve({ data: { code: 200, data: { ...page.provider, refreshSummary: {
      imported, preserved: 3, skipped: [{ id: "video-needs-config", reason: "新视频模型缺少明确模式、时长分辨率或音频能力，保留人工配置" }],
    } } } }); await request; await flush();
    expect(page.text()).toContain(`本次导入或更新 ${imported} 个，跳过 1 个，保留原配置 3 个`);
    expect(page.text()).toContain("video-needs-config");
    expect(page.text()).toContain("保留人工配置");
    expect(page.text()).toContain("数量可能重叠");
    expect(page.text()).toContain("不要照搬其他型号的参数");
    page.click(`核对并配置模型 ${page.provider.label}`); await flush();
    expect(page.state.editorVisible.value).toBe(true);
    expect(page.state.editingProvider.value.id).toBe(page.provider.id);
    expect(page.writes).toHaveLength(0);
  }
  expect(page.messages.some(message => message.kind === "success")).toBe(false);
});

test("媒体刷新旧响应或非法统计不伪造数量，失败和未知跳过原因不泄露原始错误", async () => {
  const page = await createMediaSettingsPage();
  page.requests[0]!.resolve({ data: { code: 200, data: [page.provider] } }); await flush();
  for (const refreshSummary of [undefined, { imported: -1, preserved: 0, skipped: [] }]) {
    const request = page.state.fetchModels(page.provider); await flush();
    page.requests.at(-1)!.resolve({ data: { code: 200, data: { ...page.provider, refreshSummary } } }); await request; await flush();
    expect(page.text()).toContain("当前响应未提供导入、跳过和保留统计");
  }
  let request = page.state.fetchModels(page.provider); await flush();
  page.requests.at(-1)!.resolve({ data: { code: 200, data: { ...page.provider, refreshSummary: {
    imported: 0, preserved: 3, skipped: [{ id: "needs-review", reason: "secret-path" }],
  } } } }); await request; await flush();
  expect(page.text()).toContain("needs-review");
  expect(page.text()).not.toContain("secret-path");
  request = page.state.fetchModels(page.provider); await flush();
  page.requests.at(-1)!.reject(new Error("secret-key")); await request; await flush();
  expect(page.text()).toContain("本次无法确认模型列表更新结果");
  expect(page.text()).not.toContain("secret-key");
  expect(page.text()).not.toContain("needs-review");
});

test("内置道成云不预置未确认旧别名，填写密钥后使用当前目录且不改已有配置", async () => {
  const page = await createMediaSettingsPage("languagePicker");
  expect(page.state.models.value).toEqual([]);
  expect(page.calls).toEqual([]);
  (page.settings.value as any).customProviders = [{ id: "existing", models: [{ id: "old-exact-id" }] }];
  page.state.formValues.value = { apiKey: "synthetic-key" };
  await new Promise(resolve => setTimeout(resolve, 550)); await flush();
  expect(page.calls).toEqual(["/api/providers/models"]);
  page.requests[0]!.resolve({ data: { code: 200, data: [{ id: "Exact-Current-ID", label: "Current" }] } }); await flush();
  expect(page.state.models.value.map((model: any) => model.id)).toEqual(["Exact-Current-ID"]);
  expect((page.settings.value as any).customProviders).toEqual([{ id: "existing", models: [{ id: "old-exact-id" }] }]);
  page.state.formApi.value = { formData: () => ({ apiKey: "synthetic-key" }) };
  await page.state.addProvider();
  expect((page.settings.value as any).customProviders[0].models).toEqual([{ id: "old-exact-id" }]);
  expect((page.settings.value as any).customProviders[1].models.map((model: any) => model.id)).toEqual(["Exact-Current-ID"]);
});

async function createMediaSettingsPage(editor: boolean | "language" | "model" | "languagePicker" = false, model?: any) {
  const filename = fileURLToPath(new URL(`../src/components/settings/panels/${editor === "languagePicker" ? "languageModel/addProviderDialog" : editor === "language" ? "languageModel/addCustomProviderDialog" : `mediaModel/${editor === "model" ? "modelEditorDialog" : editor ? "editProviderDialog" : "index"}`}.vue`, import.meta.url));
  const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
  const script = compileScript(descriptor, { id: "mediaSettings" });
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: "mediaSettings", compilerOptions: { bindingMetadata: script.bindings } });
  const provider = { id: "tfRouter", label: "Synthetic", apiUrl: "https://synthetic.invalid/v1", modelsUrl: "https://synthetic.invalid/models", protocol: "openai-completions", apiKey: "synthetic-secret", fileName: "synthetic.ts", revision: "one", rules: [{ field: "apiKey" }], models: editor === "language" ? [
    { id: "old-saved-model", label: "Previous", type: "text" },
  ] : [
    { id: "image-one", label: "First", type: "image" }, { id: "audio-two", label: "Second", type: "audio" }, { id: "video-three", label: "Target Video", type: "video" },
  ] };
  const settings = vue.ref({ mediaProviderConfigs: { tfRouter: { apiKey: "secret-not-for-display" } } });
  const requests: { resolve: (data: unknown) => void; reject: (error: Error) => void; signal?: AbortSignal }[] = [];
  const calls: string[] = [], writes: any[] = [];
  const messages: { kind: string; text: string }[] = [];
  let accounts = 0;
  const slot = { setup: (_props: unknown, context: { slots: Record<string, (() => unknown) | undefined> }) => () => vue.h("div", context.slots.default?.()) };
  const dependencies = (name: string): any => {
    if (name === "vue") return { ...vue, defineAsyncComponent: () => slot };
    if (name === "axios") return { get(url: string) { calls.push(url); return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
      post(url: string, _body: unknown, options: { signal: AbortSignal }) { calls.push(url); return new Promise((resolve, reject) => requests.push({ resolve, reject, signal: options.signal })); },
      put(url: string, body: any) { calls.push(url); writes.push(body); return Promise.resolve({ data: { code: 200, data: { ...provider, models: body.models, revision: "two" } } }); }, isAxiosError: () => false };
    if (name === "@/stores/settings") return { settings, saveSettings: async (update: any) => { settings.value = { ...settings.value, ...update(settings.value) }; } };
    if (name === "../../formCreate") return { ...slot, copyRules: (rules: unknown) => structuredClone(rules) };
    if (name === "@toonflow/model-icons") return { modelIcon: slot };
    if (name === "@toonflow/providers") return { languageProviders: editor === "languagePicker" ? [daochengLanguage] : [] };
    if (name === "@/lib/tf") return { isTfRouterProvider: () => false };
    if (name === "element-plus") return { ElCheckbox: slot, ElMessage: Object.fromEntries(["success", "info", "error"].map(kind => [kind, (text: string) => messages.push({ kind, text })])) };
    if (name === "@toonflow/i18n/vue") return { translate: (text: string) => text };
    if (name === "@toonflow/nodes-scaffold/nodeAi") return { invalidateNodeModels() {} };
    if (name === "../../tfAccount.vue") return { setup() { accounts++; return () => vue.h("div", "account"); } };
    if (name.endsWith(".vue")) return slot;
    return {};
  };
  function evaluate(source: string) {
    const exports: any = {};
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function("require", "exports", "window", code)(dependencies, exports, { addEventListener() {}, removeEventListener() {} });
    return exports;
  }
  const component = evaluate(script.content).default;
  component.render = evaluate(template.code).render;
  let state: any;
  const setup = component.setup;
  component.setup = (props: unknown, context: unknown) => { state = setup(props, context); return state; };
  const confirmed: any[] = [];
  const app = renderer.createApp({ render: () => vue.h(component, editor === "model" ? { model, models: model ? [model] : [], modelValue: true, onConfirmed: (value: unknown) => confirmed.push(value) } : editor ? { provider, modelValue: true } : { visible: true }) });
  for (const name of ["el-dialog", "el-card", "el-text", "el-tag", "el-button", "el-space", "el-popconfirm", "el-input", "form-create", "el-scrollbar", "el-form", "el-form-item", "el-select", "el-option", "el-input-number", "el-table-v2"]) app.component(name, slot);
  app.component("el-auto-resizer", { setup: (_props: unknown, context: any) => () => vue.h("div", context.slots.default?.({ height: 300, width: 600 })) });
  for (const name of ["el-divider", "el-radio-group", "el-radio", "el-checkbox-group", "el-checkbox", "el-input-tag", "icon-arrow-right"]) app.component(name, slot);
  app.component("el-alert", { props: ["title", "description"], setup: (props: any, context: any) => () => vue.h("div", { role: "alert" }, [props.title, props.description, context.slots.default?.()]) });
  const root = node(); app.mount(root); dispose.push(() => app.unmount());
  const text = (target: HostNode): string => target.text + target.children.map(text).join("");
  const find = (target: HostNode, label: string): HostNode | undefined => target.props["aria-label"] === label ? target : target.children.map(child => find(child, label)).find(Boolean);
  return { state, provider, requests, settings, calls, writes, messages, confirmed, text: () => text(root), click: (label: string) => (find(root, label)!.props.onClick as () => void)(), accounts: () => accounts };
}
async function flush() { for (let index = 0; index < 4; index++) { await Promise.resolve(); await vue.nextTick(); } }
async function respond(request: Pending, status = healthy) { request.resolve({ data: { code: 200, data: status } }); await flush(); }
afterEach(() => { for (const stop of dispose.splice(0)) stop(); });

test("新视频模型不猜测音频能力，按资料明确选择后才确认", async () => {
  const page = await createMediaSettingsPage("model");
  Object.assign(page.state.draft.value, { id: "new-video", label: "New", type: "video", videoMode: ["text"], durationResolutionMap: [{ duration: ["4"], resolution: ["720p"] }] });
  expect(page.state.draft.value.audio).toBeUndefined();
  page.state.confirmModel(); await flush();
  expect(page.confirmed).toHaveLength(0);
  expect(page.text()).toContain("请按平台说明选择音频输出能力");
  page.state.draft.value.audio = false;
  page.state.confirmModel(); await flush();
  expect(page.confirmed[0].audio).toBe(false);
  expect(page.confirmed[0].durationResolutionMap).toEqual([{ duration: [4], resolution: ["720p"] }]);
  expect(page.calls).toHaveLength(0);
});

test("旧视频参数原样保留，修改ID提示不能照搬，缺失音频不自动补可选", async () => {
  for (const audio of [false, true, "optional", undefined]) {
    const model = { id: "old-video", label: "Old", type: "video", mode: ["text"], durationResolutionMap: [{ duration: [4], resolution: ["720p"] }], ...(audio === undefined ? {} : { audio }) };
    const page = await createMediaSettingsPage("model", model);
    expect(page.state.draft.value.audio).toBe(audio);
    page.state.draft.value.id = "new-video"; await flush();
    expect(page.text()).toContain("模型 ID 已改变，请重新核对能力参数");
    expect(page.state.draft.value.durationResolutionMap).toEqual([{ duration: ["4"], resolution: ["720p"] }]);
    page.state.draft.value.id = "old-video";
    page.state.confirmModel();
    expect(page.confirmed[0]).toEqual(model);
    expect(page.calls).toHaveLength(0);
  }
});

test("任务日志按ID日期查询，失败与恢复易辨认，切日期拒绝旧响应", async () => {
  const page = createPage();
  const id = crypto.randomUUID();
  let query = page.state.openTaskLogs({ id, createdAt: Date.parse("2026-02-01T23:30:00Z"), updatedAt: Date.parse("2026-02-02T23:30:00Z") });
  expect(page.records[0]!.body).toEqual({ startDay: "2026-02-01", endDay: "2026-02-02", taskId: id });
  page.records[0]!.resolve({ data: { code: 200, data: { incomplete: false, missingDays: [], failedDays: [], unscannedDays: [], invalidFiles: 0, limitReached: false, events: [
    { recordedAt: 1, kind: "mediaTask", stage: "recoveryStarted", status: "queued" },
    { recordedAt: 2, kind: "mediaTask", stage: "executionFailed", status: "running" },
  ] } } }); await query; await flush();
  expect(page.text()).toContain("开始续查原任务");
  expect(page.text()).toContain("执行失败，请核对原任务与费用");
  query = page.state.findTaskLogs();
  page.state.logRange.value = ["2026-02-01", "2026-02-03"];
  expect(page.records[1]!.signal.aborted).toBe(true);
  page.records[1]!.resolve({ data: { code: 200, data: { incomplete: false, missingDays: [], failedDays: [], unscannedDays: [], invalidFiles: 0, limitReached: false, events: [{ recordedAt: 3, kind: "mediaTask", stage: "recoveryStarted" }] } } });
  await query; await flush();
  expect(page.state.logsLoaded.value).toBe(false);
  query = page.state.findTaskLogs(); page.records[2]!.resolve({ data: { code: 200, data: { incomplete: false, missingDays: [], failedDays: [], unscannedDays: [], invalidFiles: 0, limitReached: false, events: [] } } }); await query; await flush();
  expect(page.text()).toContain("范围内未找到该任务记录");
  expect(page.text()).toContain("勿直接重复生成");
  query = page.state.findTaskLogs();
  page.records[3]!.resolve({ data: { code: 200, data: { events: [], incomplete: true, missingDays: ["2026-02-01"], failedDays: [],
    unscannedDays: ["2026-02-03"], invalidFiles: 1, limitReached: true, timedOut: true } } }); await query; await flush();
  expect(page.text()).toContain("结果可能不完整");
  expect(page.text()).toContain("1 条损坏、过大或无法读取的记录");
  expect(page.text()).toContain("请缩小日期范围");
  expect(page.text()).toContain("查询达到10秒时限");
  query = page.state.findTaskLogs(); page.records[4]!.reject(new Error("secret-path")); await query; await flush();
  expect(page.text()).toContain("日志未能读取");
  expect(page.text()).not.toContain("secret-path");
  page.state.logTaskId.value = "invalid"; await page.state.findTaskLogs();
  expect(page.records).toHaveLength(5);
  page.state.logTaskId.value = id;
  query = page.state.findTaskLogs(); page.state.stopTaskLogs();
  expect(page.records[5]!.signal.aborted).toBe(true);
  page.records[5]!.resolve({ data: { code: 200, data: { events: [] } } }); await query; await flush();
  expect(page.text()).toContain("已停止查询，不影响生成任务");
  expect(page.state.logsLoaded.value).toBe(false);
});

test("成员不能查询日志，管理员关闭面板清除结果并中止请求", async () => {
  const page = createPage("user");
  page.state.logTaskId.value = crypto.randomUUID(); await page.state.findTaskLogs();
  expect(page.records).toHaveLength(0);
  page.userRole.value = "admin"; await flush();
  page.state.logTaskId.value = crypto.randomUUID();
  const query = page.state.findTaskLogs();
  page.modelValue.value = false; await flush();
  expect(page.records[0]!.signal.aborted).toBe(true);
  page.records[0]!.resolve({ data: { code: 200, data: { incomplete: false, missingDays: [], failedDays: [], unscannedDays: [], invalidFiles: 0, limitReached: false, events: [] } } }); await query;
  expect(page.state.logsLoaded.value).toBe(false);
});

test("管理员看到阻塞警报，说明已有日志保留、未继续留存和管理员处理方式", async () => {
  const page = createPage();
  expect(page.requests).toHaveLength(1);
  expect(page.requests[0]!.headers["x-toonflow-workspace"]).toBe("1");
  await respond(page.requests[0]!, { ...healthy, blocked: true, reason: "日志文件数已达上限" });
  expect(page.alerts().join("")).toContain("现有日志保留");
  expect(page.alerts().join("")).toContain("新日志未继续留存");
  expect(page.alerts().join("")).toContain("联系管理员归档或扩容");
  expect(page.text()).toContain("本进程启动以来拒绝留存 2 次（非长期账本）");
});

test("状态请求失败后清除旧容量并显示未知状态，不泄露异常内容", async () => {
  const page = createPage();
  await respond(page.requests[0]!);
  const reload = page.reload();
  page.requests[1]!.reject(new Error("sensitive/path secret=doNotDisplay"));
  await reload; await flush();
  expect(page.alerts().join("")).toContain("当前留存状态未知");
  expect(page.text()).not.toContain("日志占用");
  expect(page.text()).not.toContain("doNotDisplay");
});

test("切换项目后迟到的旧响应不能覆盖新阻塞状态", async () => {
  const page = createPage();
  page.workspace.project = { directory: "/synthetic/other", serverProjectId: "two" };
  await flush();
  expect(page.requests[0]!.signal.aborted).toBe(true);
  await respond(page.requests[1]!, { ...healthy, blocked: true });
  await respond(page.requests[0]!);
  expect(page.alerts().join("")).toContain("操作日志已停止新增留存");
});

test("成员不查询也不展示管理员日志状态", async () => {
  const page = createPage("user");
  await flush(); await page.reload(); await flush();
  expect(page.requests).toHaveLength(0);
  expect(page.text()).not.toContain("日志占用");
  expect(page.text()).not.toContain("日志容量状态读取中");
});

test("本地模式查询状态，关闭抽屉后丢弃进行中的响应", async () => {
  const page = createPage("user", false);
  expect(page.requests).toHaveLength(1);
  page.modelValue.value = false;
  await flush();
  expect(page.requests[0]!.signal.aborted).toBe(true);
  await respond(page.requests[0]!, { ...healthy, blocked: true });
  expect(page.alerts().join("")).not.toContain("操作日志已停止新增留存");
});

test("角色改为成员后不再查询且清除管理员日志状态", async () => {
  const page = createPage();
  await respond(page.requests[0]!, { ...healthy, blocked: true });
  page.userRole.value = "user";
  await flush(); await page.reload(); await flush();
  expect(page.requests).toHaveLength(1);
  expect(page.text()).not.toContain("日志占用");
  expect(page.alerts().join("")).not.toContain("操作日志已停止新增留存");
});

test("现有任务轮询同时刷新日志状态，恢复后移除阻塞警报", async () => {
  const page = createPage();
  await respond(page.requests[0]!, { ...healthy, blocked: true });
  expect(page.timers.size).toBe(1);
  for (const poll of page.timers.values()) poll();
  expect(page.requests).toHaveLength(2);
  await respond(page.requests[1]!);
  expect(page.alerts().join("")).not.toContain("操作日志已停止新增留存");
  expect(page.text()).toContain("日志占用 1.0 / 10.0 MB");
  expect(page.timers.size).toBe(1);
});

for (const [label, data] of [
  ["缺少状态", {}], ["缺少限额", { blocked: false }], ["非法计数", { ...healthy, rejected: -1 }],
  ["零容量", { ...healthy, limits: { ...healthy.limits, maxBytes: 0 } }],
  ["原因超长", { ...healthy, reason: "a".repeat(501) }], ["拒绝原因类型错误", { ...healthy, lastRejectedReason: {} }],
]) {
  test(`${label}的成功响应不能当作日志正常状态展示`, async () => {
    const page = createPage();
    page.requests[0]!.resolve({ data: { code: 200, data } });
    await flush();
    expect(page.alerts().join("")).toContain("当前留存状态未知");
    expect(page.text()).not.toContain("日志占用");
  });
}

test("已知配置错误提示修正配置而非一律归档扩容", async () => {
  const page = createPage();
  await respond(page.requests[0]!, { ...healthy, blocked: true, reason: "日志容量配置无效，须使用正安全整数" });
  expect(page.alerts().join("")).toContain("容量配置设为正安全整数");
  expect(page.text()).not.toContain("归档或扩容");
});

test("未知原因不回显路径或密钥", async () => {
  const page = createPage();
  await respond(page.requests[0]!, { ...healthy, blocked: true, reason: "C:/private/data secret=doNotDisplay" });
  expect(page.alerts().join("")).toContain("请管理员检查存储或容量配置");
  expect(page.text()).not.toContain("C:/private");
  expect(page.text()).not.toContain("doNotDisplay");
});

test("单条过大拒绝历史不显示为全部日志停止", async () => {
  const page = createPage();
  await respond(page.requests[0]!, { ...healthy, lastRejectedReason: "单条日志字节数超过上限" });
  expect(page.alerts().join("")).toContain("单条日志过大");
  expect(page.alerts().join("")).toContain("这是单次拒绝历史，当前未报告整体停止");
  expect(page.text()).not.toContain("操作日志已停止新增留存");
});

test("审核冲突保留草稿，取消重读不覆盖，确认后使用最新修订号保存", async () => {
  const page = createPage("user"); await flush();
  page.state.openReview({ id: "taskOne", review: { revision: 1, decision: "approved", comment: "old" } });
  page.state.reviewComment.value = "my draft";
  const save = page.state.saveReview();
  page.writes[0]!.reject(new Error("审核结论已被更新")); await save; await flush();
  expect(page.state.reviewComment.value).toBe("my draft");
  expect(page.alerts().join("")).toContain("当前草稿暂时保留");
  await page.state.saveReview();
  expect(page.writes).toHaveLength(1);
  const cancelled = page.state.reloadReview();
  expect(page.confirmations[0]!.message).toContain("未保存的草稿将丢失");
  page.confirmations[0]!.reject("cancel"); await cancelled;
  expect(page.records).toHaveLength(0);
  expect(page.state.reviewComment.value).toBe("my draft");
  const reload = page.state.reloadReview(); page.confirmations[1]!.resolve(); await flush();
  page.records[0]!.resolve({ data: { code: 200, data: { id: "taskOne", review: { revision: 2, decision: "changesRequested", comment: "latest" } } } });
  await reload;
  expect(page.state.reviewComment.value).toBe("latest");
  page.state.reviewComment.value = "reviewed latest";
  const retry = page.state.saveReview();
  expect(page.writes[1]!.body.revision).toBe(2);
  page.writes[1]!.resolve({ data: { code: 200, data: {} } }); await retry; await flush();
  expect(page.text()).toContain("审核结果已保存");
  expect(page.state.reviewVisible.value).toBe(false);
});

test("切项目后取消和续查不阻塞新操作，旧响应不能清除新忙碌状态或报错", async () => {
  for (const [action, staleFailure] of [["cancel", true], ["cancel", false], ["resume", true], ["resume", false]] as const) {
    const page = createPage(); await flush();
    const first = page.state[action]({ id: "oldTask" });
    if (action === "cancel") { page.confirmations[0]!.resolve(); await flush(); }
    expect(page.actions).toHaveLength(1);
    page.workspace.project = { directory: "/synthetic/other", serverProjectId: "two" }; await flush();
    const second = page.state[action]({ id: "newTask" });
    if (action === "cancel") { expect(page.confirmations).toHaveLength(2); page.confirmations[1]!.resolve(); await flush(); }
    expect(page.actions).toHaveLength(2);
    expect(page.actions[0]!.signal.aborted).toBe(true);
    expect(page.actions[1]!.body).toEqual({ directory: "/synthetic/other", id: "newTask" });
    const statusRequests = page.requests.length;
    if (staleFailure) page.actions[0]!.reject(new Error("old failure"));
    else page.actions[0]!.resolve({ data: { code: 200 } });
    await first;
    expect(page.requests).toHaveLength(statusRequests);
    expect(page.errors).toEqual([]);
    expect(page.state[action === "cancel" ? "cancelling" : "resuming"].value).toBe("newTask");
    page.actions[1]!.resolve({ data: { code: 200 } }); await second;
    expect(page.state[action === "cancel" ? "cancelling" : "resuming"].value).toBe("");
  }
});

test("取消确认期间关闭重开后可操作新任务，旧确认不提交", async () => {
  const page = createPage(); await flush();
  const first = page.state.cancel({ id: "oldTask" });
  page.modelValue.value = false; await flush();
  page.modelValue.value = true; await flush();
  const second = page.state.cancel({ id: "newTask" });
  expect(page.confirmations).toHaveLength(2);
  page.confirmations[0]!.resolve(); await first;
  expect(page.actions).toHaveLength(0);
  expect(page.state.cancelling.value).toBe("newTask");
  page.confirmations[1]!.resolve(); await flush();
  expect(page.actions).toHaveLength(1);
  expect(page.actions[0]!.body.id).toBe("newTask");
  page.actions[0]!.resolve({ data: { code: 200 } }); await second;
});

test("切项目后旧审核请求不能清除新保存的忙碌状态", async () => {
  const page = createPage("user"); await flush();
  page.state.openReview({ id: "old" });
  const oldSave = page.state.saveReview();
  page.workspace.project = { directory: "/synthetic/other", serverProjectId: "two" }; await flush();
  expect(page.writes[0]!.signal.aborted).toBe(true);
  page.state.openReview({ id: "new" });
  const newSave = page.state.saveReview();
  page.writes[0]!.resolve({ data: { code: 200 } }); await oldSave;
  expect(page.state.reviewSaving.value).toBe(true);
  expect(page.state.reviewVisible.value).toBe(true);
  page.writes[1]!.resolve({ data: { code: 200 } }); await newSave;
});

test("成本保存断线保留草稿且不重试PUT，确认重读后展示成功并清除过期成功提示", async () => {
  const page = createPage("admin", true, true);
  page.records[0]!.resolve({ data: { code: 200, data: { current: null, history: [] } } }); await flush();
  page.state.source.value = "bill"; page.state.amount.value = "0.123456"; page.state.status.value = "confirmed";
  const save = page.state.save(); page.writes[0]!.reject(new Error("response lost")); await save; await flush();
  expect(page.state.amount.value).toBe("0.123456");
  await page.state.save(); expect(page.writes).toHaveLength(1);
  const cancelled = page.state.reload(); page.confirmations[0]!.reject("cancel"); await cancelled;
  expect(page.records).toHaveLength(1);
  const reload = page.state.reload(); page.confirmations[1]!.resolve(); await flush();
  const latest = { revision: 2, status: "confirmed", amount: "0.123456", currency: "CNY", source: "bill", note: "", recordedAt: 1, actor: null };
  page.records[1]!.resolve({ data: { code: 200, data: { current: latest, history: [latest] } } }); await reload;
  const retry = page.state.save();
  expect(page.writes[1]!.body.revision).toBe(2);
  expect(page.writes[1]!.body.amount).toBe("0.123456");
  page.writes[1]!.resolve({ data: { code: 200, data: { current: { ...latest, revision: 3 }, history: [latest] } } }); await retry; await flush();
  expect(page.text()).toContain("核对记录已保存（第 3 次），未执行扣款或退款");
  page.state.note.value = "unsaved"; await flush();
  expect(page.text()).not.toContain("核对记录已保存");
});

test("成本重读确认迟到，关闭重开后不能覆盖新草稿", async () => {
  const page = createPage("admin", true, true);
  page.records[0]!.resolve({ data: { code: 200, data: { current: null, history: [] } } }); await flush();
  const reload = page.state.reload();
  page.modelValue.value = false; await flush();
  page.modelValue.value = true; await flush();
  page.records[1]!.resolve({ data: { code: 200, data: { current: null, history: [] } } }); await flush();
  page.state.source.value = "new draft";
  page.confirmations[0]!.resolve(); await reload;
  expect(page.records).toHaveLength(2);
  expect(page.state.source.value).toBe("new draft");
});

test("成本重读确认期间卸载后不再发出读取请求", async () => {
  const page = createPage("admin", true, true);
  page.records[0]!.resolve({ data: { code: 200, data: { current: null, history: [] } } }); await flush();
  const reload = page.state.reload();
  page.stop();
  page.confirmations[0]!.resolve(); await reload;
  expect(page.records).toHaveLength(1);
});

for (const status of [401, 403, 404, 500]) test(`任务刷新${status}时授权失效清除旧结果，服务故障保留结果`, async () => {
  let failure = false;
  const page = createPage("user", true, false, () => failure ? Promise.reject({ response: { status, data: { message: "访问失败" } } }) : Promise.resolve({ data: { code: 200, data: { tasks: [], total: 0, corruptCount: 0, corruptTaskIds: [] } } }));
  await flush();
  page.state.tasks.value = [{ id: "cachedTask", status: "succeeded", files: [] }];
  page.state.total.value = 1;
  page.state.previewVisible.value = true;
  failure = true;
  await page.state.load(); await flush();
  expect(page.state.tasks.value.length).toBe(status === 500 ? 1 : 0);
  expect(page.state.total.value).toBe(status === 500 ? 1 : 0);
  expect(page.state.previewVisible.value).toBe(status === 500);
  expect(page.state.loadError.value).toBe("访问失败");
});

for (const operation of ["preview", "download"] as const) test(`撤权刷新后${operation}迟到响应不恢复预览或保存文件`, async () => {
  let denied = false;
  const page = createPage("user", true, false, () => denied ? Promise.reject({ response: { status: 404, data: { message: "项目不存在" } } }) : Promise.resolve({ data: { code: 200, data: { tasks: [], total: 0, corruptCount: 0, corruptTaskIds: [] } } }));
  await flush();
  const pending = page.state[operation]("task", { path: "sample.mp4", mimeType: "video/mp4", mediaType: "video" });
  await flush();
  expect(page.fileRequests).toHaveLength(1);
  denied = true; await page.state.load();
  expect(page.fileRequests[0]!.signal.aborted).toBe(true);
  page.fileRequests[0]!.resolve(operation === "preview" ? "blob:late" : new ArrayBuffer(4));
  await pending; await flush();
  expect(page.state.previewUrl.value).toBe("");
  expect(page.state.previewVisible.value).toBe(false);
  expect(page.saved).toHaveLength(0);
  expect(page.state.downloadNotice.value).toBe("");
});

test("项目上下文失效后迟到任务列表不恢复旧数据", async () => {
  let finish: (value: unknown) => void;
  const page = createPage("user", true, false, () => new Promise(resolve => { finish = resolve; }));
  await flush();
  page.modelValue.value = false; await flush();
  finish!({ data: { code: 200, data: { tasks: [{ id: "lateTask" }], total: 1, corruptCount: 0, corruptTaskIds: [] } } });
  await flush();
  expect(page.state.tasks.value).toEqual([]);
  expect(page.state.total.value).toBe(0);
});
