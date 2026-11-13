/**
 * 道成云异步视频适配器，协议：https://doc.fytoken.net/openapi/relay.json。
 * 提交一次后查询平台任务，通过鉴权下载接口获取成片，不自动重发生成请求。
 */
const defaultBaseUrl = "https://www.fytoken.net/v1";

// 宿主静态解析表单与元数据，地址必须直接使用字面量，不能引用 defaultBaseUrl。
const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "请求地址",
    value: "https://www.fytoken.net/v1",
    props: { placeholder: "https://www.fytoken.net/v1" },
  },
] as const;

const version = "2.0.1";

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("道成云响应格式错误");
  return value as Record<string, unknown>;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 5000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function connection(config: { apiKey?: string; baseUrl?: string }) {
  const apiKey = config.apiKey?.trim().replace(/^Bearer\s+/i, "");
  if (!apiKey) throw new Error("请填写 API Key");
  const address = new URL(config.baseUrl?.trim() || defaultBaseUrl);
  if (address.protocol !== "https:" || address.username || address.password || address.search || address.hash) {
    throw new Error("请求地址必须是无账号密码、查询参数和片段的 HTTPS 地址");
  }
  const path = address.pathname.replace(/\/+$/, "");
  address.pathname = path === "" ? "/v1" : path;
  const baseUrl = address.href.replace(/\/+$/, "");
  return { apiKey, baseUrl };
}

async function videoResult(context: ProviderContext<{ apiKey?: string; baseUrl?: string }>, id: string): Promise<MediaAsset[]> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("供应商任务 ID 无效");
  const { apiKey, baseUrl } = connection(context.config);
  const headers = { Authorization: `Bearer ${apiKey}` };
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const taskId = encodeURIComponent(id);
  while (true) {
    await wait(signal);
    const response = await context.tool.fetch(`${baseUrl}/video/generations/${taskId}`, { headers, signal, redirect: "error" });
    if (!response.ok) throw new Error(`查询视频任务失败：HTTP ${response.status}，请在平台核对任务`);
    const result = object(await response.json());
    if (result.code !== "success") throw new Error(context.tool.errorMessage(result) || "查询视频任务失败");
    const task = object(result.data);
    if (task.status === "SUCCESS") break;
    if (task.status === "FAILURE") throw new Error(context.tool.errorMessage(task) || "视频生成失败，请向平台核对费用");
    if (!["NOT_START", "SUBMITTED", "QUEUED", "IN_PROGRESS"].includes(String(task.status))) throw new Error("视频任务状态未知，请在平台核对任务");
  }
  const download = await context.tool.fetch(`${baseUrl}/videos/${taskId}/content`, { headers, signal, redirect: "error" });
  if (!download.ok) throw new Error(`下载视频失败：HTTP ${download.status}，请在平台下载原任务结果`);
  const mimeType = download.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!mimeType?.startsWith("video/") || !download.body) {
    await download.body?.cancel();
    throw new Error("下载接口未返回视频文件");
  }
  // ACT: 与宿主结果下载一致，单个视频最多 100 MB；更大文件需改为流式落盘协议。
  const reader = download.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 100 * 1024 * 1024) throw new Error("视频超过 100 MB，请在平台下载原任务结果");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!size) throw new Error("下载的视频为空");
  return [{ mediaType: "video", type: "binary", data: Buffer.concat(chunks), mimeType }];
}

export default {
  id: "daochengCloud",
  label: "道成云",
  version,
  apiUrl: defaultBaseUrl,
  modelsUrl: "https://www.fytoken.net/v1/models",
  readme: `通过道成云异步视频接口调用 Seedance 2.0，费用由平台结算。请求地址可填写站点地址或包含 /v1 的地址。
模型需要在当前令牌分组中开通渠道；停止本地等待不代表上游取消或退款。
接口文档：https://doc.fytoken.net/api/video`,
  rules,
  models: [
    {
      id: "doubao-seedance-2-0-260128",
      label: "Seedance 2.0",
      type: "video",
      mode: ["text", "singleImage"],
      audio: "optional",
      durationResolutionMap: [
        { duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] },
      ],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const { apiKey, baseUrl } = connection(this.config);
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请选择模型并填写提示词");
    // ACT: 首批仅开放文生视频和首帧输入，更多参数待渠道联调后扩展。
    if (request.lastFrame || (request.images?.length ?? 0) > 1 || (request.firstFrame && request.images?.length) || request.videos?.length || request.audios?.length) {
      throw new Error("当前道成云适配仅支持文本和首帧图片");
    }
    if (request.other && Object.keys(request.other).length) throw new Error("当前道成云适配暂不支持扩展参数");
    if (request.duration !== undefined && (!Number.isInteger(request.duration) || request.duration < 4 || request.duration > 15)) throw new Error("视频时长须为 4～15 的整数秒，实际可用范围以渠道响应为准");
    if (request.resolution !== undefined && !["480p", "720p", "1080p"].includes(request.resolution)) throw new Error("当前支持 480p、720p 或 1080p");

    const image = (input: MediaInput, role: string) => ({ type: "image_url", image_url: { url: mediaUrl(input) }, role });
    const content: Record<string, unknown>[] = [{ type: "text", text: request.prompt }];
    const firstFrame = request.firstFrame ?? request.images?.[0];
    if (firstFrame) content.push(image(firstFrame, "first_frame"));
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const headers = { Authorization: `Bearer ${apiKey}` };
    const response = await this.tool.fetch(`${baseUrl}/video/generations`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        content,
        duration: request.duration,
        resolution: request.resolution,
        // ACT: 保留原适配器的画幅与水印扩展字段，实际生效范围仍须渠道联调确认。
        ratio: request.ratio,
        watermark: request.watermark,
        generate_audio: request.generateAudio,
      }),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error(this.tool.errorMessage(await response.text()) || `请求失败：HTTP ${response.status}`);
    const submitted = object(await response.json());
    if (typeof submitted.task_id !== "string" || !submitted.task_id.trim()) throw new Error("提交响应缺少任务 ID，请先在平台核对任务，勿直接重新生成");
    this.tool.reportTask?.(submitted.task_id);
    return videoResult(this, submitted.task_id);
  },
  async resumeVideo(taskId: string): Promise<MediaAsset[]> {
    return videoResult(this, taskId);
  },
} satisfies ProviderDefinition<typeof rules>;
