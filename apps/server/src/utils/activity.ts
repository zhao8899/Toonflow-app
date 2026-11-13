import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { lstat, opendir, readFile, lstatSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeAtomicSync } from "@toonflow/file";
import type { Request, Response, NextFunction } from "express";
import conf from "@/utils/conf";

function logDirectory(day: string) { return join(dirname(conf.path), "activity", day); }
const defaultLimits = { maxBytes: 256 * 1024 * 1024, maxFiles: 100000, maxRecordBytes: 256 * 1024, minFreeBytes: 1024 ** 3 };
const capacity = { bytes: 0, files: 0, lastScannedAt: null as number | null, rejected: 0, lastRejectedAt: null as number | null, lastRejectedReason: null as string | null };
let lastScanAttempt: number | undefined;
let scanProblem: string | null = null;
let writeProblem: string | null = null;
let lastWarning: number | undefined;
const handledErrors = new WeakSet<object>();

export function isActivityError(error: unknown) {
  return typeof error === "object" && error !== null && handledErrors.has(error);
}

function readCapacity() {
  const now = Date.now();
  const limits = { ...defaultLimits };
  let reason: string | null = null;
  for (const [key, name] of [["maxBytes", "MAX_BYTES"], ["maxFiles", "MAX_FILES"], ["maxRecordBytes", "MAX_RECORD_BYTES"], ["minFreeBytes", "MIN_FREE_BYTES"]] as const) {
    const value = process.env[`TOONFLOW_ACTIVITY_${name}`];
    if (value === undefined) continue;
    const number = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) reason = "日志容量配置无效，须使用正安全整数";
    else limits[key] = number;
  }
  // ACT: 单进程同步累加，首次及每 60 秒重扫元数据；外部变动最多延迟 60 秒，不支持多进程共享配额。
  if (lastScanAttempt === undefined || now - lastScanAttempt >= 60000) {
    lastScanAttempt = now;
    try {
      const root = join(dirname(conf.path), "activity");
      const pending = [root];
      let bytes = 0, files = 0;
      while (pending.length) {
        const path = pending.pop()!;
        let info;
        try { info = lstatSync(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && path === root) continue;
          throw error;
        }
        if (info.isSymbolicLink()) throw new Error("unsafe link");
        if (path === root && !info.isDirectory()) throw new Error("invalid log root");
        if (info.isDirectory()) {
          for (const name of readdirSync(path)) pending.push(join(path, name));
        } else if (info.isFile()) { bytes += info.size; files++; }
        else throw new Error("unsupported entry");
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(files)) throw new Error("capacity overflow");
      }
      capacity.bytes = bytes; capacity.files = files; capacity.lastScannedAt = now;
      scanProblem = null;
    } catch { scanProblem = "日志容量扫描失败或存在不安全链接，已停止新增日志"; }
  }
  reason ??= scanProblem;
  let availableBytes: number | null = null;
  try {
    const disk = statfsSync(dirname(conf.path), { bigint: true });
    const available = disk.bavail * disk.bsize;
    availableBytes = Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available);
    if (available < BigInt(limits.minFreeBytes)) reason ??= "磁盘剩余空间低于日志保留阈值";
  } catch { reason ??= "无法检查日志磁盘剩余空间，已停止新增日志"; }
  if (capacity.files >= limits.maxFiles) reason ??= "日志文件数已达上限";
  if (capacity.bytes >= limits.maxBytes) reason ??= "日志总字节数已达上限";
  return { ...capacity, limits, availableBytes, blocked: reason !== null, reason };
}

export function getActivityStatus() {
  const status = readCapacity();
  return { ...status, blocked: status.blocked || writeProblem !== null, reason: status.reason ?? writeProblem };
}

function rejectActivity(reason: string): never {
  const now = Date.now();
  capacity.rejected++;
  capacity.lastRejectedAt = now;
  capacity.lastRejectedReason = reason;
  if (lastWarning === undefined || now - lastWarning >= 60000) {
    lastWarning = now;
    console.error(`操作日志写入已拒绝：${reason}；本进程累计未保存 ${capacity.rejected} 条`);
  }
  const error = Object.assign(new Error(`${reason}；本次操作日志未保存`), { status: 503 });
  handledErrors.add(error);
  throw error;
}

function prepareLogDirectory(directory: string) {
  for (const path of [join(dirname(conf.path), "activity"), directory]) {
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe log directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(path);
    }
  }
}
export function promptFingerprint(prompt: string) {
  return createHash("sha256").update(String(redact(prompt))).digest("hex");
}

export function redact(value: unknown): unknown {
  const settings = conf.get("settings", {});
  const secrets: string[] = [];
  const collect = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    for (const [key, entry] of Object.entries(item)) {
      if (/^(apiKey|secret|token|password|authorization|cookie)$/i.test(key) && typeof entry === "string" && entry.length >= 6) secrets.push(entry);
      else if (entry && typeof entry === "object") collect(entry);
    }
  };
  collect(settings.customProviders);
  collect(settings.mediaProviderConfigs);
  function clean(value: unknown): unknown {
    if (typeof value === "string") {
      let text = value;
      for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
      value = text;
    }
    if (typeof value === "string") return value.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[redacted]")
      .replace(/((?:api[_-]?key|secret|token|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
      .replace(/([?&][^=&#\s]+)=[^&#\s"'<>]*/g, "$1=[redacted]");
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(apiKey|secret|token|password|authorization|cookie)$/i.test(key))
      .map(([key, item]) => [key, clean(item)]));
    return value;
  }
  return clean(value);
}

export function recordActivity(event: Record<string, unknown>) {
  const status = readCapacity();
  if (status.reason) rejectActivity(status.reason);
  const input = event.input as { prompt?: unknown } | undefined;
  const output = event.output as { enhancedPrompt?: unknown } | undefined;
  const prompt = event.prompt ?? output?.enhancedPrompt ?? input?.prompt;
  if (typeof prompt === "string") event = { ...event, promptHash: promptFingerprint(prompt) };
  const now = Date.now();
  const id = crypto.randomUUID();
  const directory = logDirectory(new Date(now).toISOString().slice(0, 10));
  let text: string;
  try { text = JSON.stringify({ ...redact(event) as object, id, recordedAt: now, schemaVersion: 1 }); }
  catch { return rejectActivity("日志内容无法序列化"); }
  const bytes = Buffer.byteLength(text);
  if (bytes > status.limits.maxRecordBytes) rejectActivity("单条日志字节数超过上限");
  if (bytes > status.limits.maxBytes - status.bytes) rejectActivity("日志剩余字节配额不足以保存本条记录");
  if (status.availableBytes === null || bytes > status.availableBytes - status.limits.minFreeBytes) rejectActivity("写入本条日志将低于磁盘保留阈值");
  try {
    prepareLogDirectory(directory);
    writeAtomicSync(join(directory, `${now}${id}.json`), text, { exclusive: true, mode: 0o600 });
  } catch {
    writeProblem = "日志存储写入失败，未确认保存";
    return rejectActivity(writeProblem);
  }
  capacity.bytes += bytes; capacity.files++;
  writeProblem = null;
}

export function exportActivity(day: string, taskId?: string) {
  let names: string[];
  try { names = readdirSync(logDirectory(day)).filter(name => /^\d+[a-f0-9-]+\.json$/.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  // ACT: 单机按天导出，超过 20 MB 明确拒绝；大规模日志改用数据库分页，不静默丢弃记录。
  let bytes = 0;
  const events = names.map(name => {
    const text = readFileSync(join(logDirectory(day), name), "utf8");
    bytes += Buffer.byteLength(text);
    if (bytes > 20 * 1024 * 1024) throw Object.assign(new Error("当天日志超过 20 MB，请由管理员从数据目录归档"), { status: 413 });
    return JSON.parse(text);
  });
  if (!taskId) return events;
  // ACT: 沿用按天20MB读取上限，不跨天全盘扫描；查询仅返回阶段摘要，避免展示历史请求正文。
  return taskActivitySummary(events, taskId);
}

function taskActivitySummary(events: any[], taskId: string) {
  return events.filter(event => typeof event?.taskId === "string" && event.taskId.toLowerCase() === taskId.toLowerCase()
    && ["mediaTask", "http"].includes(event.kind)).map(event => Object.fromEntries(
      ["id", "recordedAt", "kind", "taskId", "stage", "status", "billingState", "providerTaskId", "fileCount", "elapsedMs", "requestId", "method"]
        .filter(key => ["string", "number"].includes(typeof event[key])).map(key => [key, event[key]])
    )).sort((left, right) => Number(left.recordedAt) - Number(right.recordedAt));
}

export async function findTaskActivity(startDay: string, endDay: string, taskId: string, signal?: AbortSignal) {
  const start = Date.parse(startDay), end = Date.parse(endDay);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 6 * 86400000) {
    throw Object.assign(new Error("请选择先后顺序正确、最多7天的日期范围"), { status: 400 });
  }
  const events: Record<string, unknown>[] = [];
  const missingDays: string[] = [], failedDays: string[] = [], unscannedDays: string[] = [];
  let scannedFiles = 0, scannedBytes = 0, invalidFiles = 0, limitReached = false, timedOut = false;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 10000);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  // ACT: 流式异步枚举，不全量排序目录；最多7天/10000目录条目/20MB/2000结果/10秒。
  // 元数据系统调用无法强行中断，返回后检查取消；读文件传递signal，提前退出会关闭目录句柄。
  try {
    for (let time = start; time <= end; time += 86400000) {
      const day = new Date(time).toISOString().slice(0, 10);
      signal?.throwIfAborted();
      if (limitReached || timedOut) { unscannedDays.push(day); continue; }
      try {
        combined.throwIfAborted();
        const root = await lstat(join(dirname(conf.path), "activity"));
        combined.throwIfAborted();
        const info = await lstat(logDirectory(day));
        combined.throwIfAborted();
        if (root.isSymbolicLink() || !root.isDirectory() || info.isSymbolicLink() || !info.isDirectory()) throw new Error();
        const directory = await opendir(logDirectory(day));
        if (combined.aborted) { await directory.close(); combined.throwIfAborted(); }
        for await (const entry of directory) {
          combined.throwIfAborted();
          if (scannedFiles >= 10000 || events.length >= 2000) { limitReached = true; break; }
          scannedFiles++;
          if (!/^\d+[a-f0-9-]+\.json$/.test(entry.name)) continue;
          try {
            const path = join(logDirectory(day), entry.name), info = await lstat(path);
            combined.throwIfAborted();
            if (!info.isFile() || info.isSymbolicLink()) throw new Error();
            if (info.size > 20 * 1024 * 1024 - scannedBytes) { limitReached = true; break; }
            // 单条解析限制与默认写入上限一致，避免历史大JSON独占事件循环；原文件保留并报告跳过。
            if (info.size > defaultLimits.maxRecordBytes) { invalidFiles++; continue; }
            const text = await readFile(path, { encoding: "utf8", signal: combined });
            combined.throwIfAborted();
            scannedBytes += Buffer.byteLength(text);
            if (scannedBytes > 20 * 1024 * 1024) { limitReached = true; break; }
            if (Buffer.byteLength(text) > defaultLimits.maxRecordBytes) { invalidFiles++; continue; }
            const event = JSON.parse(text);
            if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.kind !== "string"
              || typeof event.recordedAt !== "number" || !Number.isFinite(event.recordedAt)) throw new Error();
            events.push(...taskActivitySummary([event], taskId));
          } catch (error) { if (combined.aborted) throw error; invalidFiles++; }
        }
        combined.throwIfAborted();
        if (limitReached) unscannedDays.push(day);
      } catch (error) {
        signal?.throwIfAborted();
        if (timeout.signal.aborted) { timedOut = true; unscannedDays.push(day); }
        else if ((error as NodeJS.ErrnoException).code === "ENOENT") missingDays.push(day);
        else failedDays.push(day);
      }
    }
    signal?.throwIfAborted();
    events.sort((left, right) => Number(left.recordedAt) - Number(right.recordedAt));
    return { startDay, endDay, timezone: "UTC", events, scannedFiles, scannedBytes, invalidFiles,
      missingDays, failedDays, unscannedDays, limitReached, timedOut,
      incomplete: !!(missingDays.length || failedDays.length || unscannedDays.length || invalidFiles) };
  } finally { clearTimeout(timer); }
}

export function activityMiddleware(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD"].includes(req.method) && /^\/activity\/status\/?$/i.test(req.path)) return next();
  // 只读跨天查询不自记录，避免结束查询时重新触发同步日志容量扫描。
  if (req.method === "GET" && /^\/activity\/export\/?$/i.test(req.path) && (req.query.startDay !== undefined || req.query.endDay !== undefined)) return next();
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  res.locals.activityId = requestId;
  res.setHeader("x-toonflow-request-id", requestId);
  let finished = false;
  const record = () => {
    if (finished) return;
    finished = true;
    try {
      const route = req.originalUrl.split("?")[0]!;
      let details: unknown;
      let detailsOmitted = false;
      if (/^\/api\/ai\/media\/tasks\/(create|review|cost|cancel|resume)$/.test(route) && req.method !== "GET" && req.body) {
        const selected = Object.fromEntries(Object.entries(req.body).filter(([key]) =>
          ["providerId", "modelId", "prompt", "mode", "duration", "resolution", "ratio", "generateAudio", "firstFrame", "lastFrame", "images", "videos", "audios", "decision", "comment", "revision", "status", "amount", "currency", "source", "note"].includes(key)));
        if (Buffer.byteLength(JSON.stringify(selected)) <= 128 * 1024) details = selected;
        else detailsOmitted = true;
      }
      const bounded = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;
      recordActivity({ kind: "http", requestId, method: req.method, route: req.originalUrl.split("?")[0],
        actorId: res.locals.userId ?? null, role: res.locals.userRole ?? (req.app.locals.authRequired ? "anonymous" : "local"), projectId: res.locals.project?.id,
        status: res.writableFinished ? res.statusCode : 499, durationMs: Date.now() - startedAt,
        directory: bounded(req.body?.directory ?? req.query.directory, 4096),
        taskId: bounded(req.body?.requestId ?? req.body?.id ?? req.query.id, 200), details, detailsOmitted,
      });
    } catch (error) {
      if (!isActivityError(error)) {
        try { rejectActivity("请求操作日志构造失败，未确认保存"); } catch { /* 已累计并限频告警，不能让已完成业务重复执行。 */ }
      }
    }
  };
  res.once("finish", record);
  res.once("close", record);
  next();
}
