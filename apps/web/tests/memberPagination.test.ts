import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFile } from "@toonflow/file";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";

type Project = { id: string; name: string };
type Result = { data: { code: number; message: string; data: { projects: Project[]; total: number } } };
type PendingRequest = { offset: number; signal: AbortSignal; resolve: (result: Result) => void; reject: (cause: Error) => void };
type State = { offset: vue.Ref<number>; refresh: vue.Ref<number>; projects: vue.Ref<Project[]>; total: vue.Ref<number>; loading: vue.Ref<boolean>; errorMessage: vue.Ref<string> };

const filename = fileURLToPath(new URL("../src/pages/member/index.vue", import.meta.url));
const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
const compiled = compileScript(descriptor, { id: "memberPagination" });
const javascript = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const scopes: vue.EffectScope[] = [];

function createPage() {
  const requests: PendingRequest[] = [];
  const axios = {
    get(_url: string, options: { params: { offset: number }; signal: AbortSignal }) {
      // Deliberately allow an already-aborted transport to resolve: the page must reject stale responses itself.
      return new Promise<Result>((resolve, reject) => requests.push({ offset: options.params.offset, signal: options.signal, resolve, reject }));
    },
    isAxiosError: () => false,
  };
  const exports: { default?: { setup: (props: object, context: { expose: () => void }) => State } } = {};
  const require = (id: string) => {
    if (id === "vue") return vue;
    if (id === "axios") return axios;
    if (id === "element-plus") return { ElMessage: { error() {} } };
    if (id === "@/stores/workspace") return { useWorkspaceStore: () => ({}) };
    if (id.endsWith(".vue")) return {};
    throw new Error(`Unexpected component dependency: ${id}`);
  };
  new Function("require", "exports", javascript)(require, exports);
  const scope = vue.effectScope();
  scopes.push(scope);
  const state = scope.run(() => exports.default!.setup({}, { expose() {} }))!;
  return { state, requests, scope };
}

async function respond(request: PendingRequest, total: number, projects: Project[] = []) {
  request.resolve({ data: { code: 200, message: "", data: { projects, total } } });
  await Promise.resolve();
  await vue.nextTick();
}

afterEach(() => { for (const scope of scopes.splice(0)) scope.stop(); });

for (const [total, expectedOffset] of [[30, 0], [60, 30], [0, 0]]) {
  test(`项目缩减到 ${total} 条时，从第三页回退到 offset ${expectedOffset} 并重新加载`, async () => {
    const page = createPage();
    await respond(page.requests[0]!, 90, [{ id: "old", name: "旧项目" }]);
    page.state.offset.value = 60;
    await vue.nextTick();
    expect(page.requests[1]!.offset).toBe(60);
    await respond(page.requests[1]!, total!);
    expect(page.state.offset.value).toBe(expectedOffset!);
    expect(page.requests).toHaveLength(3);
    expect(page.requests[2]!.offset).toBe(expectedOffset!);
    const projects = total ? [{ id: "current", name: "当前项目" }] : [];
    await respond(page.requests[2]!, total!, projects);
    expect(page.state.projects.value).toEqual(projects);
    expect(page.state.total.value).toBe(total!);
    expect(page.state.loading.value).toBe(false);
  });
}

test("有效的最后一页不会重发请求或跳到首页", async () => {
  const page = createPage();
  await respond(page.requests[0]!, 45);
  page.state.offset.value = 30;
  await vue.nextTick();
  const projects = [{ id: "last", name: "最后一页" }];
  await respond(page.requests[1]!, 45, projects);
  expect(page.requests).toHaveLength(2);
  expect(page.state.offset.value).toBe(30);
  expect(page.state.projects.value).toEqual(projects);
});

test("已取消的旧响应不能覆盖刷新后的列表或触发错误分页回退", async () => {
  const page = createPage();
  await respond(page.requests[0]!, 90);
  page.state.offset.value = 60;
  await vue.nextTick();
  page.state.refresh.value++;
  await vue.nextTick();
  expect(page.requests[1]!.signal.aborted).toBe(true);
  const projects = [{ id: "new", name: "新响应" }];
  await respond(page.requests[2]!, 90, projects);
  await respond(page.requests[1]!, 0);
  expect(page.state.offset.value).toBe(60);
  expect(page.state.total.value).toBe(90);
  expect(page.state.projects.value).toEqual(projects);
  expect(page.requests).toHaveLength(3);
});

test("卸载后返回的响应不会更新成员项目状态", async () => {
  const page = createPage();
  page.scope.stop();
  expect(page.requests[0]!.signal.aborted).toBe(true);
  await respond(page.requests[0]!, 1, [{ id: "late", name: "迟到响应" }]);
  expect(page.state.projects.value).toEqual([]);
  expect(page.state.total.value).toBe(0);
});
