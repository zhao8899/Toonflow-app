import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdir, mkdtemp, readFile, rm, withFileAccess, writeAtomic } from "@toonflow/file";

let server: Server | undefined;
let origin = "";
let temporaryDirectory = "";
let directory = "";
const password = crypto.randomUUID();
const isolatedProcess = process.env.TOONFLOW_BUSINESS_FLOW_CHILD === "1";
const environmentKeys = ["TOONFLOW_DATA_DIR", "TOONFLOW_AUTH_REQUIRED", "TOONFLOW_ADMIN_USERNAME", "TOONFLOW_ADMIN_PASSWORD", "NODE_ENV"] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));

beforeAll(async () => {
  if (!isolatedProcess) return;
  const suppliedDirectory = process.env.TOONFLOW_BUSINESS_FLOW_DIRECTORY;
  if (!suppliedDirectory || !resolve(suppliedDirectory).startsWith(`${resolve(tmpdir())}${sep}toonflowBusinessFlow`)) {
    throw new Error("HTTP 验证必须使用父进程创建的临时目录");
  }
  temporaryDirectory = resolve(suppliedDirectory);
  directory = join(temporaryDirectory, "workspaces", "projectOne");
  await mkdir(directory, { recursive: true });
  process.env.TOONFLOW_DATA_DIR = temporaryDirectory;
  process.env.TOONFLOW_AUTH_REQUIRED = "true";
  process.env.TOONFLOW_ADMIN_USERNAME = "flowAdmin";
  process.env.TOONFLOW_ADMIN_PASSWORD = password;
  process.env.NODE_ENV = "test";
  // conf 是进程内单例；本文件在独立子进程执行，首次动态导入前固定临时目录。
  const { createApp } = await import("../src/app");
  const app = await createApp({ dataDirectory: temporaryDirectory, webRoot: join(temporaryDirectory, "web") });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("回环服务未取得端口");
  origin = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  if (!isolatedProcess) return;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  for (const key of environmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const root = resolve(tmpdir());
  const target = resolve(temporaryDirectory);
  if (temporaryDirectory && target.startsWith(`${root}${sep}toonflowBusinessFlow`)) await rm(target, { recursive: true, force: true });
});

async function request(path: string, cookie = "", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  headers.set("x-toonflow-workspace", "1");
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${origin}/api/${path}`, { ...init, headers });
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function login(username: string) {
  const response = await request("auth/login", "", json("POST", { username, password }));
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect((await response.json()).data.token).toBeUndefined();
  return cookie;
}

test("真实 HTTP：认证隔离、任务、合成结果审片与人工费用核对", async () => {
  if (!isolatedProcess) {
    const childDirectory = await mkdtemp(join(tmpdir(), "toonflowBusinessFlow"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const running = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, TOONFLOW_BUSINESS_FLOW_CHILD: "1", TOONFLOW_BUSINESS_FLOW_DIRECTORY: childDirectory },
        stdout: "pipe", stderr: "pipe",
      });
      child = running;
      timer = setTimeout(() => { timedOut = true; running.kill("SIGKILL"); }, 25000);
      const [exitCode, stdout, stderr] = await Promise.all([
        running.exited, new Response(running.stdout).text(), new Response(running.stderr).text(),
      ]);
      if (timedOut || exitCode !== 0) throw new Error(`隔离 HTTP 验证${timedOut ? "超时" : "失败"}（${exitCode}）\n${stdout}\n${stderr}`);
      expect(exitCode).toBe(0);
      console.info(`隔离 HTTP 子进程验证结果：\n${stderr.trim().split("\n").slice(-4).join("\n")}`);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      const target = resolve(childDirectory);
      if (target.startsWith(`${resolve(tmpdir())}${sep}toonflowBusinessFlow`)) await rm(target, { recursive: true, force: true });
    }
    return;
  }
  expect((await request("settings/get")).status).toBe(401);
  const admin = await login("flowAdmin");
  const catalogRequests: string[] = [];
  const catalog = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    catalogRequests.push(`${req.method} ${new URL(req.url).pathname}`);
    if (req.headers.get("authorization") !== "Bearer catalogOnly") return Response.json({ error: "syntheticUnauthorized" }, { status: 401 });
    return Response.json({ data: [
      { id: "textOne", supported_endpoint_types: ["openai"] },
      { id: "videoOne", supported_endpoint_types: ["openai-video"] },
      { id: "mixedOne", supported_endpoint_types: ["openai-video", "openai"] },
      { id: "legacyOne" },
      { id: "customOne", supported_endpoint_types: ["custom-protocol"] },
    ] });
  } });
  try {
    const payload = { apiUrl: `http://127.0.0.1:${catalog.port}/v1`, protocol: "openai-completions", apiKey: "catalogOnly" };
    const found = await request("providers/models", admin, json("POST", payload));
    expect(found.status).toBe(200);
    expect((await found.json()).data.map((item: { id: string }) => item.id)).toEqual(["textOne", "mixedOne", "legacyOne", "customOne"]);
    const denied = await request("providers/models", admin, json("POST", { ...payload, apiKey: "" }));
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(await denied.json())).not.toContain("syntheticUnauthorized");
    expect(catalogRequests).toEqual(["GET /v1/models", "GET /v1/models"]);
  } finally { await catalog.stop(true); }
  const createMember = await request("users/create", admin, json("POST", { username: "flowMember", password, role: "user" }));
  expect(createMember.status).toBe(201);
  const memberId = (await createMember.json()).data.id;
  const member = await login("flowMember");
  expect((await request("settings/get", member)).status).toBe(403);

  const register = await request("projects/register", admin, json("POST", { directory, name: "HTTP 验收项目" }));
  expect(register.status).toBe(200);
  const projectId = (await register.json()).data.id;
  expect((await request(`projects/get?id=${projectId}`, member)).status).toBe(404);
  expect((await request("projects/members", admin, json("PUT", { id: projectId, members: [memberId] }))).status).toBe(200);
  const memberProject = await request(`projects/get?id=${projectId}`, member);
  expect(memberProject.status).toBe(200);
  expect((await memberProject.json()).data.members).toEqual([]);

  const query = new URLSearchParams({ directory, path: "range.txt" });
  const contents = "0123456789";
  expect((await request(`workspaces/files/write?${query}&exclusive=true`, admin, {
    method: "PUT", headers: { "content-type": "application/octet-stream" }, body: contents,
  })).status).toBe(200);
  expect((await request(`workspaces/files/write?${query}&exclusive=true`, admin, {
    method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "replacement",
  })).status).toBe(409);
  expect((await request(`workspaces/files/read?${query}`, member)).status).toBe(403);
  const headers = { "x-toonflow-project-id": projectId };
  const full = await request(`workspaces/files/read?${query}`, member, { headers });
  expect(full.status).toBe(200);
  expect(await full.text()).toBe(contents);
  const partial = await request(`workspaces/files/read?${query}`, member, { headers: { ...headers, range: "bytes=2-5" } });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(await partial.text()).toBe("2345");
  const traversal = new URLSearchParams({ directory, path: "../../settings.json" });
  expect((await request(`workspaces/files/read?${traversal}`, member, { headers })).status).toBe(400);

  const taskInput = { directory, requestId: crypto.randomUUID(), mediaType: "video", providerId: "missingProvider", modelId: "missingModel", prompt: "本地失败路径，不调用供应商", mode: "text" };
  expect((await request("ai/media/tasks/create", admin, json("POST", { ...taskInput, requestId: "invalid" }))).status).toBe(400);
  expect((await request("ai/media/tasks/create", admin, json("POST", taskInput))).status).toBe(404);
  const { addMediaProvider } = await import("../src/utils/media/provider");
  await addMediaProvider('export default { id:"missingProvider", label:"Local preflight", rules:[], models:[{id:"missingModel",label:"Video",type:"video",mode:["text"],audio:false,durationResolutionMap:[{duration:[4],resolution:["720p"]}]}] };');
  Object.assign(taskInput, { duration: 4, resolution: "720p", generateAudio: false });
  const created = await request("ai/media/tasks/create", admin, json("POST", taskInput));
  expect(created.status).toBe(202);
  const taskId = (await created.json()).data.id;
  expect(taskId).toBe(taskInput.requestId);
  const taskQuery = new URLSearchParams({ directory, id: taskId });
  let task: { status: string; billingState: string; files: unknown[] } | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await request(`ai/media/tasks/get?${taskQuery}`, admin);
    expect(response.status).toBe(200);
    task = (await response.json()).data;
    if (task?.status === "failed") break;
    await Bun.sleep(20);
  }
  expect(task?.status).toBe("failed");
  expect(task?.billingState).toBe("notSubmitted");
  expect(task?.files).toEqual([]);
  const repeated = await request("ai/media/tasks/create", admin, json("POST", taskInput));
  expect(repeated.status).toBe(202);
  expect((await repeated.json()).data.id).toBe(taskId);
  expect((await request("ai/media/tasks/create", admin, json("POST", { ...taskInput, prompt: "不同请求" }))).status).toBe(409);
  const listed = await request(`ai/media/tasks/list?${new URLSearchParams({ directory })}`, admin);
  expect(listed.status).toBe(200);
  expect((await listed.json()).data.total).toBe(1);

  // 合成 SVG 只验证成功结果的审片与人工费用持久化；不代表供应商生成或视频解码通过。
  const actor = (await (await request("auth/session", admin)).json()).data;
  const { startMediaTask } = await import("../src/utils/media/tasks");
  const generated = startMediaTask(directory, "image", { providerId: "localSynthetic", modelId: "reviewFrame", prompt: "本地合成结果，无供应商调用" }, async () => {
    await writeAtomic(join(directory, "reviewFrame.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>', { exclusive: true });
    return [{ path: "reviewFrame.svg", mimeType: "image/svg+xml", mediaType: "image" }];
  }, crypto.randomUUID(), undefined, { id: actor.id, username: actor.username, member: false });
  const completed = await generated.completion;
  expect(completed.status).toBe("succeeded");
  const resultId = completed.id;
  const resultQuery = new URLSearchParams({ directory, id: resultId });
  const normalized = process.platform === "win32" ? directory.toLowerCase() : directory;
  const recordPath = join(temporaryDirectory, "mediaTasks", createHash("sha256").update(normalized).digest("hex"), `${resultId}.json`);
  const scopedJson = (body: unknown) => ({ ...json("PUT", body), headers: { "content-type": "application/json", ...headers } });
  const reviewInput = { directory, id: resultId, revision: 0, decision: "approved", comment: "合成结果通过" };
  const costInput = { directory, id: resultId, revision: 0, status: "disputed", amount: null, currency: "CNY", source: "合成核对凭据，不是供应商账单", note: "待核对" };
  async function readResult(endpoint: string, query = resultQuery) {
    const response = await request(`ai/media/tasks/${endpoint}?${query}`, admin, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()).data;
  }

  expect((await request("ai/media/tasks/review", "", scopedJson(reviewInput))).status).toBe(401);
  expect((await request("ai/media/tasks/review", member, json("PUT", reviewInput))).status).toBe(403);
  expect((await request("ai/media/tasks/review", admin, scopedJson({ ...reviewInput, id: taskId }))).status).toBe(409);
  const reviewResponses = await Promise.all([
    request("ai/media/tasks/review", member, scopedJson({ ...reviewInput, reviewer: { id: "forged", username: "forged" } })),
    request("ai/media/tasks/review", member, scopedJson({ ...reviewInput, decision: "changesRequested", comment: "需要调整", reviewer: { id: "forged", username: "forged" } })),
  ]);
  expect(reviewResponses.map(response => response.status).sort()).toEqual([200, 409]);
  const firstReview = (await reviewResponses.find(response => response.status === 200)!.json()).data.review;
  expect(firstReview.revision).toBe(1);
  expect(firstReview.reviewer.id).toBe(memberId);
  expect(firstReview.reviewer.username).toBe("flowMember");
  expect(await readResult("reviewHistory")).toEqual([firstReview]);

  const privateDirectory = join(temporaryDirectory, "workspaces", "privateProject");
  await mkdir(privateDirectory);
  const privateProjectResponse = await request("projects/register", admin, json("POST", { directory: privateDirectory, name: "未授权项目" }));
  expect(privateProjectResponse.status).toBe(200);
  const privateProjectId = (await privateProjectResponse.json()).data.id;
  const beforeDenied = await readFile(recordPath, "utf8");
  expect((await request("ai/media/tasks/review", member, scopedJson({ ...reviewInput, directory: privateDirectory }))).status).toBe(403);
  const privateHeaders = { "content-type": "application/json", "x-toonflow-project-id": privateProjectId };
  expect((await request("ai/media/tasks/review", member, { ...json("PUT", { ...reviewInput, directory: privateDirectory }), headers: privateHeaders })).status).toBe(404);
  expect((await request(`ai/media/tasks/reviewHistory?${new URLSearchParams({ directory: privateDirectory, id: resultId })}`, member, { headers: privateHeaders })).status).toBe(404);
  expect((await request("ai/media/tasks/review", admin, { ...json("PUT", { ...reviewInput, directory: privateDirectory }), headers: privateHeaders })).status).toBe(404);
  expect(await readFile(recordPath, "utf8")).toBe(beforeDenied);

  for (const endpoint of ["costHistory", "costExport"]) {
    expect((await request(`ai/media/tasks/${endpoint}?${resultQuery}`, member, { headers })).status).toBe(403);
  }
  expect((await request("ai/media/tasks/cost", member, scopedJson(costInput))).status).toBe(403);
  expect(await readResult("costHistory")).toEqual({ current: null, history: [] });
  const disputedResponse = await request("ai/media/tasks/cost", admin, scopedJson({ ...costInput, actor: { id: "forged", username: "forged" } }));
  expect(disputedResponse.status).toBe(200);
  const disputed = (await disputedResponse.json()).data.current;
  expect(disputed).toMatchObject({ revision: 1, status: "disputed", amount: null, currency: "CNY", actor: { id: actor.id, username: actor.username } });
  const costResponses = await Promise.all([
    request("ai/media/tasks/cost", admin, scopedJson({ ...costInput, revision: 1, status: "confirmed", amount: "0.123456" })),
    request("ai/media/tasks/cost", admin, scopedJson({ ...costInput, revision: 1, status: "confirmed", amount: "2.500000" })),
  ]);
  expect(costResponses.map(response => response.status).sort()).toEqual([200, 409]);
  const confirmed = (await costResponses.find(response => response.status === 200)!.json()).data.current;
  expect(confirmed.revision).toBe(2);
  expect(["0.123456", "2.500000"]).toContain(confirmed.amount);
  expect(confirmed.status).toBe("confirmed");
  expect((await readResult("get")).review).toEqual(firstReview);
  const zeroResponse = await request("ai/media/tasks/cost", admin, scopedJson({ ...costInput, revision: 2, status: "confirmed", amount: "0" }));
  expect(zeroResponse.status).toBe(200);
  const zeroCost = (await zeroResponse.json()).data.current;
  expect(zeroCost).toMatchObject({ revision: 3, status: "confirmed", amount: "0", currency: "CNY" });

  const secondReviewResponse = await request("ai/media/tasks/review", admin, scopedJson({ ...reviewInput, revision: 1, comment: "管理员复核" }));
  expect(secondReviewResponse.status).toBe(200);
  const secondReview = (await secondReviewResponse.json()).data.review;
  expect(secondReview).toMatchObject({ revision: 2, reviewer: { id: actor.id } });
  expect((await readResult("costHistory")).current).toEqual(zeroCost);
  const finalCostInput = { ...costInput, revision: 3, status: "confirmed", amount: "12.340000", currency: "USD", note: "合成费用调整" };
  const finalCostResponse = await request("ai/media/tasks/cost", admin, scopedJson(finalCostInput));
  expect(finalCostResponse.status).toBe(200);
  const ledger = (await finalCostResponse.json()).data;
  expect(ledger.current).toMatchObject({ revision: 4, status: "confirmed", amount: "12.340000", currency: "USD" });
  expect(ledger.history).toEqual([ledger.current, zeroCost, confirmed, disputed]);
  expect(await readResult("costHistory")).toEqual(ledger);
  expect(await readResult("reviewHistory")).toEqual([secondReview, firstReview]);
  const exported = await readResult("costExport", new URLSearchParams({ directory }));
  expect(exported.tasks.find((item: { id: string }) => item.id === resultId).cost).toEqual(ledger.current);
  expect(exported.tasks.find((item: { id: string }) => item.id === taskId).cost).toBeNull();
  const visibleResult = await request(`ai/media/tasks/get?${resultQuery}`, member, { headers });
  expect(visibleResult.status).toBe(200);
  const publicResult = (await visibleResult.json()).data;
  expect(publicResult.cost).toBeUndefined();
  expect(publicResult.costHistory).toBeUndefined();
  expect(publicResult.review).toEqual(secondReview);
  expect(publicResult.status).toBe("succeeded");
  expect(publicResult.billingState).toBe("providerManaged");

  const beforeFailure = await readFile(recordPath, "utf8");
  for (const amount of [null, "-1", "0.1234567", "1e3", 12]) {
    const response = await request("ai/media/tasks/cost", admin, scopedJson({ ...finalCostInput, revision: 4, amount }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).not.toBe(200);
    expect(await readFile(recordPath, "utf8")).toBe(beforeFailure);
  }
  expect((await request("ai/media/tasks/review", admin, scopedJson({ ...reviewInput, revision: 2, comment: "长".repeat(2001) }))).status).toBe(400);
  await withFileAccess([recordPath], "read", async () => {
    for (const [endpoint, body] of [["review", { ...reviewInput, revision: 2 }], ["cost", { ...finalCostInput, revision: 4 }]] as const) {
      const response = await request(`ai/media/tasks/${endpoint}`, admin, scopedJson(body));
      expect(response.status).toBe(500);
      expect((await response.json()).code).not.toBe(200);
    }
  });
  expect(await readFile(recordPath, "utf8")).toBe(beforeFailure);
  expect(await readResult("reviewHistory")).toEqual([secondReview, firstReview]);
  expect(await readResult("costHistory")).toEqual(ledger);
  expect((await readResult("costExport", new URLSearchParams({ directory }))).tasks.find((item: { id: string }) => item.id === resultId).cost).toEqual(ledger.current);
  expect((await request("projects/members", admin, json("PUT", { id: projectId, members: [] }))).status).toBe(200);
  expect((await request(`workspaces/files/read?${query}`, member, { headers })).status).toBe(404);
  expect((await request("ai/media/tasks/review", member, scopedJson({ ...reviewInput, revision: 2 }))).status).toBe(404);
  expect((await request(`ai/media/tasks/reviewHistory?${resultQuery}`, member, { headers })).status).toBe(404);
}, 30000);
