import { createHash } from "node:crypto";
import { t, translateMessage } from "@/lib/i18n";
import { mkdir, readFile, realpath, stat, withFileAccess } from "@toonflow/file";
import { join, relative } from "node:path";
import { mediaProviders, type Provider } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { beginGeneration, getProviderPrice } from "@/utils/media/billing";
import { detectMimeType, readPriceReference } from "@/utils/media/priceReference";
import { startMediaTask, getMediaTaskRecovery, resumeMediaTask } from "@/utils/media/tasks";
import { downloadPublic, publicAddress } from "@/utils/network/publicDownload";
import { getRuntimePlatform } from "@/lib/platform";

const maxMediaSize = 100 * 1024 * 1024;
const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(): Promise<MediaModel[]> {
  const installedProviders = await listMediaProviders();
  return installedProviders.flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      supportsPrice: "supportsPrice" in provider && provider.supportsPrice === true,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(t`参考媒体类型须为 ${mediaType}`);
  return { type: "base64", data: bytes.toString("base64"), mimeType, name: reference.path };
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  if (!/^https?:\/\//i.test(url)) invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  // 服务器部署时供应商返回的地址不可信：拦截本机、内网与元数据地址，连接时固定已校验 IP，重定向逐跳复查。
  // ACT: 桌面与本机开发保留原下载方式，兼容本机运行的自建模型服务；该模式下仅本机用户自己可用。
  if (!getRuntimePlatform().local) {
    const result = await downloadPublic(publicAddress(url), {
      signal: signal ?? new AbortController().signal, maxSize: maxMediaSize, tooLarge: "生成文件不能超过 100 MB", accept: "*/*",
    });
    return { bytes: result.bytes, mimeType: result.contentType };
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(t`下载生成结果失败（HTTP ${response.status}）`);
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("生成文件不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("生成结果为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMediaSize) invalid("生成文件不能超过 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    const responseMimeType = result.mimeType.split(";")[0].trim().toLowerCase();
    mimeType = responseMimeType && responseMimeType !== "application/octet-stream" ? result.mimeType : mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}

async function prepareRequest<T>(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest,
  read: (cwd: string, reference: MediaReference, type: string, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  const references = async (items: MediaReference[] | undefined, type: string) => {
    if (!items?.length) return items ? [] : undefined;
    if (!directory) invalid("参考媒体需要工作目录");
    // ACT: 单次请求顺序处理引用，避免数十个参考媒体同时启动探测进程。
    const result: T[] = [];
    for (const item of items) result.push(await read(directory, item, type, signal));
    return result;
  };
  const images = await references(request.images, "image");
  if (mediaType === "audio") return {
    type: "audio" as const, model: request.modelId, text: request.prompt, images, audios: await references(request.audios, "audio"),
    voice: request.voice, speed: request.speed, volume: request.volume, pitch: request.pitch, language: request.language, format: request.format, sampleRate: request.sampleRate,
  };
  if (mediaType === "image") return { type: "image" as const, model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size };
  return {
    type: "video" as const, model: request.modelId, prompt: request.prompt, images,
    videos: await references(request.videos, "video"), audios: await references(request.audios, "audio"),
    firstFrame: (await references(request.firstFrame ? [request.firstFrame] : undefined, "image"))?.[0],
    lastFrame: (await references(request.lastFrame ? [request.lastFrame] : undefined, "image"))?.[0],
    ratio: request.ratio, resolution: request.resolution, duration: request.duration, generateAudio: request.generateAudio, mode: request.mode,
  };
}

async function validateGenerationModel(request: MediaGenerationRequest, mediaType: "image" | "video" | "audio") {
  const info = await getMediaProvider(request.providerId);
  const model = info.models.find(model => model.id === request.modelId && model.type === mediaType);
  if (!model) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  if (mediaType === "video") {
    const modes = model.mode;
    if (!Array.isArray(modes) || !modes.length) invalid("该视频模型的生成模式尚未确认，请先核实模型配置");
    const mode = request.mode;
    if (!mode) invalid("请选择视频生成模式，不使用供应商默认模式");
    const selected = modes.find(item => Array.isArray(mode) ? Array.isArray(item) && item.length === mode.length && item.every(value => (mode as unknown[]).includes(value)) : item === mode);
    if (selected === undefined) invalid("该模型不支持所选视频模式，请重新选择");
    const images = request.images?.length ?? 0, videos = request.videos?.length ?? 0, audios = request.audios?.length ?? 0;
    if (Array.isArray(mode)) {
      if (request.firstFrame || request.lastFrame) invalid("混合参考模式不能同时提交首尾帧字段");
      const limits = new Map<string, number>();
      for (const item of mode) {
        const match = /^(image|video|audio)Reference:([1-9]\d*)$/.exec(item);
        if (!match || limits.has(match[1]) || !Number.isSafeInteger(Number(match[2]))) invalid("该模式参考数量配置无效，请先核实模型配置");
        limits.set(match[1], Number(match[2]));
      }
      if (!images && !videos && !audios) invalid("混合参考模式至少需要一个参考素材");
      for (const [type, count] of [["image", images], ["video", videos], ["audio", audios]] as const) {
        if (count > (limits.get(type) ?? 0)) invalid("参考素材类型或数量超出所选模式支持范围");
      }
    } else {
      if (videos || audios) invalid("所选视频模式不支持视频或音频参考素材");
      const first = !!request.firstFrame, last = !!request.lastFrame;
      if (mode === "text" && (images || first || last)) invalid("文生视频模式不能附带参考素材");
      if (mode === "singleImage" && (images !== 1 || first || last)) invalid("单图模式需要且只能通过图片参考提供一张图片，不能混用首尾帧字段");
      if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) {
        if (images || mode !== "startFrameOptional" && !first || mode !== "endFrameOptional" && !last) invalid("首尾帧输入与所选模式不匹配，请核对必填图片");
      } else if (!["text", "singleImage"].includes(mode)) invalid("视频模式尚未支持，请先核实模型配置");
    }
    const map = model.durationResolutionMap;
    if (!Array.isArray(map) || !map.length) invalid("该视频模型的时长与分辨率能力尚未确认，请先核实模型配置");
    if (request.duration === undefined || !request.resolution) invalid("请选择明确的视频时长和分辨率，不使用未知默认值");
    if (!Number.isFinite(request.duration) || request.duration <= 0 || !map.some(value => { const row = record(value); return Array.isArray(row.duration) && row.duration.includes(request.duration) && Array.isArray(row.resolution) && row.resolution.includes(request.resolution); })) invalid("该模型不支持所选时长与分辨率组合，请重新选择");
    if (model.audio !== true && model.audio !== false && model.audio !== "optional") invalid("该视频模型的音频能力尚未确认，请先核实模型配置");
    if (typeof request.generateAudio !== "boolean") invalid("请选择是否生成音频，不使用未知默认值");
    if (model.audio !== "optional" && request.generateAudio !== model.audio) invalid(model.audio ? "该模型始终输出音频，不能关闭" : "该模型不支持生成音频，请关闭音频选项");
  }
  return info;
}

async function configuredProvider(request: MediaGenerationRequest, mediaType: "image" | "video" | "audio", signal?: AbortSignal, directory?: string) {
  const info = await validateGenerationModel(request, mediaType);
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  return loadMediaProviderSource(info.source, record(configurations[info.id]), signal, undefined, directory);
}

async function preparePriceRequest(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try { return await prepareRequest(directory, mediaType, request, readPriceReference, combined); }
  catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error("读取参考媒体信息超时，请稍后重试");
    throw error;
  }
}

export async function getMediaPrice(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const provider = await configuredProvider(request, mediaType, signal, directory);
  if (!provider.getPrice) return null;
  const prepared = await preparePriceRequest(directory, mediaType, request, signal);
  signal?.throwIfAborted();
  return getProviderPrice(provider, prepared);
}

async function validateOutputDirectory(directory: string, outputDirectory: string) {
  const { path } = await resolveWorkspacePath(directory, outputDirectory, true);
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && !info.isDirectory()) invalid("输出目录已被文件占用，请选择其他目录后重试");
}

async function executeGeneration(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
  progress?: (status: "running" | "saving", files?: GeneratedMedia[], providerTaskId?: string, providerConfigHash?: string) => void,
  authorize?: () => void,
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  await validateOutputDirectory(directory, outputDirectory);
  const provider = await configuredProvider(request, mediaType, signal, directory);
  provider.tool.reportTask = id => progress?.("running", undefined, id, provider.resumeVideo ? providerConfigHash(provider.config) : undefined);
  const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
  if (typeof generate !== "function") invalid(t`此供应商不支持${translateMessage({ image: "图片", video: "视频", audio: "音频" }[mediaType])}生成`);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("请先在媒体模型设置中配置供应商 API Key");
  const prepared = await prepareRequest(directory, mediaType, request, readReference, signal);
  signal?.throwIfAborted();
  authorize?.();
  const finish = beginGeneration(provider);
  try {
    signal?.throwIfAborted();
    const { type, ...parameters } = prepared;
    progress?.("running");
    const assets = type === "audio" ? await provider.generateAudio!(parameters as AudioRequest)
      : type === "image" ? await provider.generateImage!(parameters as ImageRequest) : await provider.generateVideo!(parameters as VideoRequest);
    return await saveGeneratedAssets(directory, mediaType, assets, outputDirectory, signal, progress);
  } finally { finish(); }
}

export async function submitMediaGeneration(cwd: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, id: string,
  actor?: { id: string; username: string; member: boolean }, authorize?: () => void) {
  const directory = await realpath(cwd);
  authorize?.();
  const validation = await validateGenerationModel(request, mediaType).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  authorize?.();
  // 先复用原任务/拒绝已关闭ID，再校验新任务，配置变化不能破坏原提交核对协议。
  return startMediaTask(directory, mediaType, request, (signal, progress) => executeGeneration(directory, mediaType, request, signal, progress, authorize), id, undefined, actor,
    () => { if (!validation.ok) throw validation.error; }).task;
}

export async function generateMedia(cwd: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal): Promise<GeneratedMedia[]> {
  const directory = await realpath(cwd);
  signal?.throwIfAborted();
  await validateGenerationModel(request, mediaType);
  const { completion } = startMediaTask(directory, mediaType, request,
    (taskSignal, progress) => executeGeneration(directory, mediaType, request, taskSignal, progress), undefined, signal);
  const task = await completion;
  if (task.status !== "succeeded") throw new Error(`${task.error ?? "生成未完成"}（任务 ${task.id}）`);
  return task.files;
}

function providerConfigHash(config: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(config, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value)).digest("hex");
}

async function saveGeneratedAssets(directory: string, mediaType: "image" | "video" | "audio", assets: MediaAsset[],
  outputDirectory: string, signal?: AbortSignal, progress?: (status: "running" | "saving", files?: GeneratedMedia[]) => void) {
  const result: GeneratedMedia[] = [];
  if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
  progress?.("saving");
  for (const asset of assets) {
    signal?.throwIfAborted();
    const { bytes, mimeType } = await assetBytes(asset, mediaType, signal);
    signal?.throwIfAborted();
    // ACT: 单工作区仅保存阶段排队；下载仍并行。根目录作队列键，避免 mkdir 同一输出路径重入文件队列。
    await withFileAccess([directory], "write", async () => {
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      signal?.throwIfAborted();
      const release = lockWorkspaceFiles([output.path]);
      try {
        if (relative(directory, output.path) !== "") await mkdir(output.path, { recursive: true });
        const file = join(outputDirectory, `${mediaType}${crypto.randomUUID()}.${mediaExtensions[mimeType]}`);
        const { path } = await resolveWorkspacePath(directory, file);
        signal?.throwIfAborted();
        await writeWorkspaceFile(path, bytes, true);
        result.push({ path: relative(directory, path).replace(/\\/g, "/"), mimeType, mediaType });
        progress?.("saving", result);
      } finally { release(); }
    }, signal);
  }
  signal?.throwIfAborted();
  return result;
}

export async function resumeMediaGeneration(cwd: string, id: string) {
  const directory = await realpath(cwd);
  const task = getMediaTaskRecovery(directory, id);
  const info = await getMediaProvider(task.providerId);
  const config = record(record(conf.get("settings", {}).mediaProviderConfigs)[task.providerId]);
  const provider = await loadMediaProviderSource(info.source, config, undefined, undefined, directory);
  if (!provider.resumeVideo) invalid("此供应商不支持续查已有视频任务");
  const configHash = providerConfigHash(provider.config);
  const outputDirectory = task.outputDirectory ?? "assets/generated";
  await validateOutputDirectory(directory, outputDirectory);
  return resumeMediaTask(directory, id, configHash, async (signal, progress) => {
    const runtime = await loadMediaProviderSource(info.source, config, signal, undefined, directory);
    progress("running");
    const assets = await runtime.resumeVideo!(task.providerTaskId!);
    return saveGeneratedAssets(directory, "video", assets, outputDirectory, signal, progress);
  }).task;
}
