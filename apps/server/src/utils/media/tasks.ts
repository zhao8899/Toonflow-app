import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statfsSync, writeAtomicSync } from "@toonflow/file";
import { z } from "zod";
import type { GeneratedMedia, MediaGenerationRequest, MediaTask, MediaTaskFilters } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { redact, promptFingerprint, recordActivity, isActivityError } from "@/utils/activity";
import { assertMemberGeneration, findProject, findProjectId } from "@/utils/workspace/projects";

const reviewSchema = z.object({
  revision: z.number().int().positive(), decision: z.enum(["approved", "changesRequested"]),
  comment: z.string().max(2000), reviewedAt: z.number(),
  reviewer: z.object({ id: z.string(), username: z.string() }).nullable(),
});
export const costInputSchema = z.object({
  status: z.enum(["confirmed", "disputed"]),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/).nullable(),
  currency: z.enum(["CNY", "USD"]), source: z.string().trim().min(1).max(500), note: z.string().trim().max(2000),
}).refine(value => value.status !== "confirmed" || value.amount !== null, "已核对费用必须填写金额");
const costSchema = costInputSchema.safeExtend({
  revision: z.number().int().positive(), recordedAt: z.number(),
  actor: z.object({ id: z.string(), username: z.string() }).nullable(),
});
const taskSchema = z.object({
  promptHash: z.string().optional(),
  request: z.record(z.string(), z.json()).optional(),
  timeline: z.array(z.object({ status: z.string(), at: z.number() })).optional(),
  completedAt: z.number().optional(),
  createdBy: z.object({ id: z.string(), username: z.string() }).optional(),
  billingOwner: z.literal("instance").optional(),
  memberRequest: z.boolean().optional(),
  id: z.uuid(), mediaType: z.enum(["image", "video", "audio"]),
  projectId: z.uuid().optional(),
  providerId: z.string(), modelId: z.string(),
  status: z.enum(["queued", "running", "saving", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]),
  billingState: z.enum(["notSubmitted", "providerManaged", "unknown"]),
  providerTaskId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  providerConfigHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  outputDirectory: z.string().max(4096).optional(),
  createdAt: z.number(), updatedAt: z.number(),
  files: z.array(z.object({ path: z.string(), mimeType: z.string(), mediaType: z.enum(["image", "video", "audio"]) })),
  error: z.string().optional(), requestHash: z.string(),
  cost: costSchema.optional(),
  costHistory: z.array(costSchema).max(100).optional(),
  review: reviewSchema.optional(),
  reviewHistory: z.array(reviewSchema).max(100).optional(),
});
type TaskRecord = z.infer<typeof taskSchema>;
const submissionSchema = z.object({
  version: z.literal(1), state: z.literal("closed"), requestId: z.uuid(), projectId: z.uuid(),
  actorId: z.string().min(1).max(100), closedAt: z.number().int().nonnegative(),
});
type Progress = (status: "running" | "saving", files?: GeneratedMedia[], providerTaskId?: string, providerConfigHash?: string) => void;
type ActiveTask = { controller: AbortController; task: TaskRecord; completion: Promise<MediaTask> };
// ACT: 与现有工作区一样只支持单进程；最多 8 个任务，扩容时迁移持久队列与共享并发控制。
const active = new Map<string, ActiveTask>();
const generationDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const pendingStatuses = new Set<MediaTask["status"]>(["queued", "running", "saving", "cancelling"]);

function taskDirectory(directory: string) {
  const normalized = process.platform === "win32" ? directory.toLowerCase() : directory;
  return join(dirname(conf.path), "mediaTasks", createHash("sha256").update(normalized).digest("hex"));
}

function taskPath(directory: string, id: string) {
  return join(taskDirectory(directory), `${z.uuid().parse(id).toLowerCase()}.json`);
}

function readSubmission(path: string, id: string) {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const marker = submissionSchema.parse(JSON.parse(text));
  if (marker.requestId !== id.toLowerCase()) throw Object.assign(new Error("提交关闭记录与请求 ID 不匹配"), { status: 409 });
  return marker;
}

function assertDiskSpace(location: string, label: string) {
  let available: bigint;
  try {
    const disk = statfsSync(location, { bigint: true });
    available = disk.bavail * disk.bsize;
  } catch {
    throw Object.assign(new Error(`无法检查${label}可用空间，已阻止新生成任务，请检查存储状态`), { status: 503 });
  }
  if (available < 1024n ** 3n) {
    throw Object.assign(new Error(`${label}可用空间不足 1 GiB，已阻止新生成任务，请清理或扩容后重试`), { status: 507 });
  }
}

export function resolveMediaSubmission(directory: string, id: string, projectId: string, actorId: string) {
  const path = taskPath(directory, id);
  if (findProjectId(directory) !== projectId) throw Object.assign(new Error("提交请求与项目不匹配"), { status: 403 });
  const previous = readTask(path);
  if (previous) {
    if (previous.createdBy?.id !== actorId || previous.projectId !== projectId) throw Object.assign(new Error("无权确认此提交请求"), { status: 403 });
    return { state: "existing" as const, task: publicTask(previous) };
  }
  const markerPath = `${path.slice(0, -5)}.submission.json`;
  const marker = readSubmission(markerPath, id);
  if (marker && (marker.projectId !== projectId || marker.actorId !== actorId)) throw Object.assign(new Error("无权确认此提交请求"), { status: 403 });
  if (!marker) {
    const closed = submissionSchema.parse({ version: 1, state: "closed", requestId: id.toLowerCase(), projectId, actorId, closedAt: Date.now() });
    assertDiskSpace(dirname(conf.path), "数据目录");
    mkdirSync(dirname(path), { recursive: true });
    // ACT: 单进程内与 startMediaTask 的判定和写入均同步；关闭记录不自动过期，防止迟到请求再次生成。
    writeAtomicSync(markerPath, `${JSON.stringify(closed)}\n`, { exclusive: true, mode: 0o600 });
  }
  return { state: "closed" as const, requestId: id.toLowerCase(), projectId, actorId };
}

function publicTask(task: TaskRecord): MediaTask {
  const { cost, costHistory, requestHash, reviewHistory, providerConfigHash, outputDirectory, ...result } = task;
  return structuredClone({ ...result, canResume: !!providerConfigHash && !!task.providerTaskId && task.mediaType === "video"
    && ["failed", "cancelled", "interrupted"].includes(task.status) && !task.files.length && !task.review && !reviewHistory?.length });
}

function recordTaskActivity(task: TaskRecord, stage: string) {
  try {
    recordActivity({ kind: "mediaTask", taskId: task.id, projectId: task.projectId,
      actorId: task.createdBy?.id ?? null, mediaType: task.mediaType, providerId: task.providerId,
      modelId: task.modelId, stage, status: task.status, billingState: task.billingState,
      providerTaskId: task.providerTaskId, fileCount: task.files.length,
      elapsedMs: Math.max(0, Date.now() - task.createdAt) });
  } catch (error) {
    // ACT: 阶段日志失败不改变任务结果或重试供应商；容量拒绝由现有状态入口累计并限频告警。
    if (!isActivityError(error)) console.error("媒体任务阶段日志未保存", task.id, stage);
  }
}

function save(path: string, task: TaskRecord, exclusive = false) {
  const changed = exclusive || task.timeline?.at(-1)?.status !== task.status;
  task.updatedAt = Date.now();
  if (task.timeline && task.timeline.at(-1)?.status !== task.status) {
    task.timeline.push({ status: task.status, at: task.updatedAt });
    if (!pendingStatuses.has(task.status)) task.completedAt = task.updatedAt;
    else delete task.completedAt;
  }
  try { writeAtomicSync(path, `${JSON.stringify(task)}\n`, { exclusive, mode: 0o600 }); }
  catch (error) { recordTaskActivity(task, "persistenceFailed"); throw error; }
  if (changed) recordTaskActivity(task, task.timeline ? "statusChanged" : "statusSnapshot");
}

function readTask(path: string): TaskRecord | undefined {
  const running = active.get(path);
  if (running) return running.task;
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const task = taskSchema.refine(value => value.id.toLowerCase() === basename(path, ".json").toLowerCase(),
    { message: "任务记录与文件 ID 不匹配", path: ["id"] }).parse(JSON.parse(text));
  if (pendingStatuses.has(task.status)) {
    task.status = "interrupted";
    task.error = "服务已中断；请先核对供应商任务与费用，再决定是否重新生成。";
    save(path, task);
  }
  return task;
}

export function getMediaTask(directory: string, id: string): MediaTask {
  const task = readTask(taskPath(directory, id));
  if (!task) throw Object.assign(new Error("生成任务不存在"), { status: 404 });
  return publicTask(task);
}

export function listMediaTasks(directory: string, offset = 0, limit = 30, filters: MediaTaskFilters = {}, tolerateCorrupt = false) {
  let corruptCount = 0;
  const corruptTaskIds: string[] = [];
  let entries: string[];
  try { entries = readdirSync(taskDirectory(directory)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [], total: 0, corruptCount, corruptTaskIds };
    throw error;
  }
  // ACT: 按项目扫描历史，O(n)；大规模历史需要数据库索引，分页只限制返回大小，不删除历史。
  const tasks = entries.filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
    .map(name => {
      try { return readTask(join(taskDirectory(directory), name)); }
      catch (error) {
        // ACT: 仅浏览列表允许隔离损坏记录；额度、成本默认失败关闭，避免低估。最多展示 10 个 ID。
        if (!tolerateCorrupt || !(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
        corruptCount++;
        if (corruptTaskIds.length < 10) corruptTaskIds.push(name.slice(0, -5));
      }
    })
    .filter((task): task is TaskRecord => !!task)
    .filter(task => {
      if (filters.mediaType && task.mediaType !== filters.mediaType) return false;
      if (filters.status && task.status !== filters.status) return false;
      if (filters.reviewState === "pending") return !pendingStatuses.has(task.status) && task.files.length > 0 && !task.review;
      return !filters.reviewState || task.review?.decision === filters.reviewState;
    })
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  return { tasks: tasks.slice(offset, offset + limit).map(publicTask), total: tasks.length, corruptCount, corruptTaskIds };
}

export function cancelMediaTask(directory: string, id: string) {
  const path = taskPath(directory, id);
  const current = active.get(path);
  if (current && pendingStatuses.has(current.task.status)) {
    current.task.status = "cancelling";
    try { save(path, current.task); }
    finally { current.controller.abort(new Error("已请求取消生成")); }
  }
  return getMediaTask(directory, id);
}

export function reviewMediaTask(
  directory: string, id: string, revision: number,
  decision: NonNullable<MediaTask["review"]>["decision"], comment: string,
  reviewer: NonNullable<MediaTask["review"]>["reviewer"],
) {
  const path = taskPath(directory, id);
  const task = readTask(path);
  if (!task) throw Object.assign(new Error("生成任务不存在"), { status: 404 });
  if (active.has(path) || pendingStatuses.has(task.status) || !task.files.length) {
    throw Object.assign(new Error("仅可审核已结束且有保存结果的任务"), { status: 409 });
  }
  if ((task.review?.revision ?? 0) !== revision) {
    throw Object.assign(new Error("审核结论已被更新，请刷新后重新审核"), { status: 409 });
  }
  const history = task.reviewHistory ?? (task.review ? [task.review] : []);
  task.review = { revision: revision + 1, decision, comment: comment.trim(), reviewedAt: Date.now(), reviewer };
  // ACT: 小团队历史与任务快照一起保存，最多 100 条；长期完整留存需迁移独立存储。
  task.reviewHistory = [task.review, ...history].slice(0, 100);
  save(path, task);
  return publicTask(task);
}

export function getMediaTaskReviewHistory(directory: string, id: string) {
  const task = readTask(taskPath(directory, id));
  if (!task) throw Object.assign(new Error("生成任务不存在"), { status: 404 });
  return structuredClone(task.reviewHistory ?? (task.review ? [task.review] : []));
}

export function getMemberGenerationQuota(directory: string, now = Date.now()) {
  const project = findProject(directory);
  if (!project) throw Object.assign(new Error("项目不存在"), { status: 404 });
  const day = generationDay.format(now);
  // ACT: 复用项目历史同步计数；历史规模增大后迁移数据库索引与事务，不另维护双写账本。
  const used = listMediaTasks(directory, 0, Number.MAX_SAFE_INTEGER).tasks.filter(task =>
    task.projectId === project.id && task.createdBy && task.memberRequest === true && generationDay.format(task.createdAt) === day).length;
  const parts = generationDay.formatToParts(now);
  const part = (type: string) => Number(parts.find(item => item.type === type)!.value);
  const resetAt = Date.UTC(part("year"), part("month") - 1, part("day") + 1) - 8 * 60 * 60 * 1000;
  const limit = project.memberDailyGenerationLimit;
  return { limit, used, remaining: Math.max(0, limit - used), resetAt, enabled: project.memberGenerationEnabled && limit > 0 };
}

export function startMediaTask(
  directory: string, mediaType: MediaTask["mediaType"], request: MediaGenerationRequest,
  execute: (signal: AbortSignal, progress: Progress) => Promise<GeneratedMedia[]>,
  id: string = crypto.randomUUID(), signal?: AbortSignal,
  actor?: { id: string; username: string; member: boolean },
  validate?: () => void,
) {
  signal?.throwIfAborted();
  const path = taskPath(directory, id);
  const requestHash = createHash("sha256").update(JSON.stringify({ mediaType, request }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value)).digest("hex");
  const previous = readTask(path);
  if (previous) {
    if (previous.createdBy?.id !== actor?.id || previous.requestHash !== requestHash) throw Object.assign(new Error("请求 ID 已用于其他生成参数，请勿重复使用"), { status: 409 });
    recordTaskActivity(previous, "submissionReused");
    return { task: publicTask(previous), completion: active.get(path)?.completion ?? Promise.resolve(publicTask(previous)) };
  }
  if (readSubmission(`${path.slice(0, -5)}.submission.json`, id)) {
    throw Object.assign(new Error("此提交请求已关闭，请使用新的请求 ID"), { status: 409 });
  }
  validate?.();
  if (active.size >= 8) throw Object.assign(new Error("正在执行的生成任务已达上限，请稍后提交"), { status: 429 });
  if (actor?.member && [...active.values()].some(entry => entry.task.createdBy?.id === actor.id)) {
    throw Object.assign(new Error("每个成员同时只能执行一个生成任务"), { status: 429 });
  }
  // ACT: 保留 1 GiB 基础余量；不是并发任务的空间预留，不能保证大批量输出不会耗尽磁盘。
  for (const [label, location] of [["数据目录", dirname(conf.path)], ["工作区", directory]] as const) {
    assertDiskSpace(location, label);
  }
  const projectId = findProjectId(directory);
  const createdAt = Date.now();
  if (actor?.member) {
    assertMemberGeneration(projectId ?? "", actor.id, request.providerId, request.modelId);
    const quota = getMemberGenerationQuota(directory, createdAt);
    if (quota.remaining === 0) {
      throw Object.assign(new Error("项目今日成员生成次数已达上限"), { status: 429 });
    }
  }
  const task: TaskRecord = {
    promptHash: promptFingerprint(request.prompt),
    request: taskSchema.shape.request.parse(redact(JSON.parse(JSON.stringify(request)))), timeline: [],
    createdBy: actor ? { id: actor.id, username: actor.username } : undefined, billingOwner: "instance",
    projectId, memberRequest: actor?.member === true,
    outputDirectory: request.outputDirectory ?? "assets/generated",
    id: id.toLowerCase(), mediaType, providerId: request.providerId, modelId: request.modelId,
    status: "queued", billingState: "notSubmitted", createdAt, updatedAt: createdAt, files: [], requestHash,
  };
  mkdirSync(dirname(path), { recursive: true });
  save(path, task, true);
  return runTask(path, task, execute, signal);
}

export function getMediaTaskRecovery(directory: string, id: string) {
  const task = readTask(taskPath(directory, id));
  if (!task) throw Object.assign(new Error("生成任务不存在"), { status: 404 });
  if (!publicTask(task).canResume) throw Object.assign(new Error("此任务不能续查：须为没有结果的异常视频任务，且保留上游任务及配置记录"), { status: 409 });
  return structuredClone(task);
}

export function resumeMediaTask(directory: string, id: string, configHash: string,
  execute: (signal: AbortSignal, progress: Progress) => Promise<GeneratedMedia[]>) {
  const task = getMediaTaskRecovery(directory, id);
  if (task.providerConfigHash !== configHash) throw Object.assign(new Error("供应商配置已改变，请恢复提交时的配置后续查"), { status: 409 });
  if (active.size >= 8) throw Object.assign(new Error("正在执行的生成任务已达上限，请稍后续查"), { status: 429 });
  task.status = "queued";
  delete task.error;
  const path = taskPath(directory, id);
  save(path, task);
  recordTaskActivity(task, "recoveryStarted");
  return runTask(path, task, execute);
}

function runTask(path: string, task: TaskRecord,
  execute: (signal: AbortSignal, progress: Progress) => Promise<GeneratedMedia[]>, signal?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const entry: ActiveTask = { controller, task, completion: Promise.resolve(publicTask(task)) };
  active.set(path, entry);
  entry.completion = Promise.resolve().then(async () => {
    try {
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(35 * 60_000)]);
      combined.throwIfAborted();
      const files = await execute(combined, (status, files, providerTaskId, providerConfigHash) => {
        // 只接受当前执行轮次的进度；取消中的上游ID仍需保留，但结束后的旧回调不能覆盖终态或续查。
        if (active.get(path) !== entry || !pendingStatuses.has(task.status)) return;
        const previousProviderTaskId = task.providerTaskId;
        task.status = controller.signal.aborted ? "cancelling" : status;
        task.billingState = "unknown";
        if (providerTaskId !== undefined) {
          task.providerTaskId = taskSchema.shape.providerTaskId.parse(providerTaskId);
        }
        if (providerConfigHash !== undefined) task.providerConfigHash = taskSchema.shape.providerConfigHash.parse(providerConfigHash);
        if (files) task.files = structuredClone(files);
        save(path, task);
        if (task.providerTaskId && task.providerTaskId !== previousProviderTaskId) recordTaskActivity(task, "providerTaskReceived");
      });
      task.files = files;
      task.status = "succeeded";
      task.billingState = "providerManaged";
      save(path, task);
    } catch {
      recordTaskActivity(task, controller.signal.aborted ? "cancellationObserved" : "executionFailed");
      task.status = controller.signal.aborted ? "cancelled" : "failed";
      // 不保存上游错误正文，避免回显密钥、临时签名链接或用户提示词。
      task.error = task.billingState === "notSubmitted"
        ? "生成未提交，请检查模型配置和参考素材。"
        : "生成未完成；已保存的文件可下载，上游结果与费用请向供应商核对。";
      if (controller.signal.aborted) task.error = task.billingState === "notSubmitted"
        ? "已在提交供应商前取消。" : "已停止本地处理；供应商是否取消或退款请另行核对。";
      try { save(path, task); }
      catch {
        task.status = "interrupted";
        task.error = "任务记录保存失败，请检查数据目录；勿直接重复生成，已有文件可在项目素材中查找。";
        throw Object.assign(new Error(task.error), { status: 500 });
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      active.delete(path);
    }
    return publicTask(task);
  });
  // 后台调用由查询接口读取结果；记录写入失败不能变成未处理的 Promise 拒绝。
  void entry.completion.catch(error => console.error("媒体任务记录保存失败", task.id, error.message));
  return { task: publicTask(task), completion: entry.completion };
}

export function getMediaTaskCostHistory(directory: string, id: string) {
  const task = readTask(taskPath(directory, id));
  if (!task) throw Object.assign(new Error("生成任务不存在"), { status: 404 });
  return structuredClone({ current: task.cost ?? null, history: task.costHistory ?? (task.cost ? [task.cost] : []) });
}

export function recordMediaTaskCost(
  directory: string, id: string, revision: number,
  input: z.infer<typeof costInputSchema>, actor: z.infer<typeof costSchema>["actor"],
) {
  const path = taskPath(directory, id);
  const task = readTask(path);
  if (!task) throw Object.assign(new Error("生成任务不存在"), { status: 404 });
  if (active.has(path) || pendingStatuses.has(task.status)) throw Object.assign(new Error("仅可核对已结束任务"), { status: 409 });
  if ((task.cost?.revision ?? 0) !== revision) throw Object.assign(new Error("成本记录已更新，请重新读取后核对"), { status: 409 });
  const cost = costSchema.parse({ ...costInputSchema.parse(input), revision: revision + 1, recordedAt: Date.now(), actor });
  // ACT: 与任务原子保存，保留最近100次人工核对；不代表长期不可篡改审计。
  task.costHistory = [cost, ...(task.costHistory ?? (task.cost ? [task.cost] : []))].slice(0, 100);
  task.cost = cost;
  save(path, task);
  return getMediaTaskCostHistory(directory, id);
}

export function exportMediaTaskCosts(directory: string) {
  const list = listMediaTasks(directory, 0, 10000);
  if (list.total > 10000) throw Object.assign(new Error("任务超过10000条，暂不支持全量导出"), { status: 413 });
  return { exportedAt: Date.now(), tasks: list.tasks.map(task => ({
    id: task.id, providerTaskId: task.providerTaskId ?? null, providerId: task.providerId, modelId: task.modelId,
    createdBy: task.createdBy ?? null, createdAt: task.createdAt, status: task.status, billingState: task.billingState,
    cost: getMediaTaskCostHistory(directory, task.id).current,
  })) };
}
