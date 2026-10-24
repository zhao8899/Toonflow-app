import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeAtomicSync } from "@toonflow/file";
import { z } from "zod";
import type { GeneratedMedia, MediaGenerationRequest, MediaTask, MediaTaskFilters } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { findProjectId } from "@/utils/workspace/projects";

const reviewSchema = z.object({
  revision: z.number().int().positive(), decision: z.enum(["approved", "changesRequested"]),
  comment: z.string().max(2000), reviewedAt: z.number(),
  reviewer: z.object({ id: z.string(), username: z.string() }).nullable(),
});
const taskSchema = z.object({
  id: z.uuid(), mediaType: z.enum(["image", "video", "audio"]),
  projectId: z.uuid().optional(),
  providerId: z.string(), modelId: z.string(),
  status: z.enum(["queued", "running", "saving", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]),
  billingState: z.enum(["notSubmitted", "providerManaged", "unknown"]),
  createdAt: z.number(), updatedAt: z.number(),
  files: z.array(z.object({ path: z.string(), mimeType: z.string(), mediaType: z.enum(["image", "video", "audio"]) })),
  error: z.string().optional(), requestHash: z.string(),
  review: reviewSchema.optional(),
  reviewHistory: z.array(reviewSchema).max(100).optional(),
});
type TaskRecord = z.infer<typeof taskSchema>;
type Progress = (status: "running" | "saving", files?: GeneratedMedia[]) => void;
type ActiveTask = { controller: AbortController; task: TaskRecord; completion: Promise<MediaTask> };
// ACT: 与现有工作区一样只支持单进程；最多 8 个任务，扩容时迁移持久队列与共享并发控制。
const active = new Map<string, ActiveTask>();
const pendingStatuses = new Set<MediaTask["status"]>(["queued", "running", "saving", "cancelling"]);

function taskDirectory(directory: string) {
  const normalized = process.platform === "win32" ? directory.toLowerCase() : directory;
  return join(dirname(conf.path), "mediaTasks", createHash("sha256").update(normalized).digest("hex"));
}

function taskPath(directory: string, id: string) {
  return join(taskDirectory(directory), `${z.uuid().parse(id).toLowerCase()}.json`);
}

function publicTask(task: TaskRecord): MediaTask {
  const { requestHash, reviewHistory, ...result } = task;
  return structuredClone(result);
}

function save(path: string, task: TaskRecord, exclusive = false) {
  task.updatedAt = Date.now();
  writeAtomicSync(path, `${JSON.stringify(task)}\n`, { exclusive, mode: 0o600 });
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
  const task = taskSchema.parse(JSON.parse(text));
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

export function listMediaTasks(directory: string, offset = 0, limit = 30, filters: MediaTaskFilters = {}) {
  let entries: string[];
  try { entries = readdirSync(taskDirectory(directory)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [], total: 0 };
    throw error;
  }
  // ACT: 按项目扫描历史，O(n)；大规模历史需要数据库索引，分页只限制返回大小，不删除历史。
  const tasks = entries.filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
    .map(name => readTask(join(taskDirectory(directory), name)))
    .filter((task): task is TaskRecord => !!task)
    .filter(task => {
      if (filters.mediaType && task.mediaType !== filters.mediaType) return false;
      if (filters.status && task.status !== filters.status) return false;
      if (filters.reviewState === "pending") return !pendingStatuses.has(task.status) && task.files.length > 0 && !task.review;
      return !filters.reviewState || task.review?.decision === filters.reviewState;
    })
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  return { tasks: tasks.slice(offset, offset + limit).map(publicTask), total: tasks.length };
}

export function cancelMediaTask(directory: string, id: string) {
  const path = taskPath(directory, id);
  const current = active.get(path);
  if (current && pendingStatuses.has(current.task.status)) {
    current.task.status = "cancelling";
    save(path, current.task);
    current.controller.abort(new Error("已请求取消生成"));
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

export function startMediaTask(
  directory: string, mediaType: MediaTask["mediaType"], request: MediaGenerationRequest,
  execute: (signal: AbortSignal, progress: Progress) => Promise<GeneratedMedia[]>,
  id: string = crypto.randomUUID(), signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const path = taskPath(directory, id);
  const requestHash = createHash("sha256").update(JSON.stringify({ mediaType, request }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value)).digest("hex");
  const previous = readTask(path);
  if (previous) {
    if (previous.requestHash !== requestHash) throw Object.assign(new Error("请求 ID 已用于其他生成参数，请勿重复使用"), { status: 409 });
    return { task: publicTask(previous), completion: active.get(path)?.completion ?? Promise.resolve(publicTask(previous)) };
  }
  if (active.size >= 8) throw Object.assign(new Error("正在执行的生成任务已达上限，请稍后提交"), { status: 429 });
  const task: TaskRecord = {
    projectId: findProjectId(directory),
    id: id.toLowerCase(), mediaType, providerId: request.providerId, modelId: request.modelId,
    status: "queued", billingState: "notSubmitted", createdAt: Date.now(), updatedAt: Date.now(), files: [], requestHash,
  };
  mkdirSync(dirname(path), { recursive: true });
  save(path, task, true);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const entry: ActiveTask = { controller, task, completion: Promise.resolve(publicTask(task)) };
  active.set(path, entry);
  entry.completion = Promise.resolve().then(async () => {
    try {
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(35 * 60_000)]);
      combined.throwIfAborted();
      const files = await execute(combined, (status, files) => {
        task.status = controller.signal.aborted ? "cancelling" : status;
        task.billingState = "unknown";
        if (files) task.files = structuredClone(files);
        save(path, task);
      });
      task.files = files;
      task.status = "succeeded";
      task.billingState = "providerManaged";
      save(path, task);
    } catch {
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
