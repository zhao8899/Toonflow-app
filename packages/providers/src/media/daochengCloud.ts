/**
 * 道成云（OpenAI 兼容网关）媒体适配器
 *
 * 依据平台提供的唯一调用示例：
 * POST {baseUrl}/chat/completions，Authorization: Bearer <API Key>，body 为 { model, messages }。
 * 视频结果从回复内容中提取地址，不依赖未确认的上传、任务或计费接口。
 */
const defaultBaseUrl = "https://ai.daochengyun.cn/v1";

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
    value: defaultBaseUrl,
    props: { placeholder: defaultBaseUrl },
  },
] as const;

const version = "1.1.0";

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

/** 回复内容可能是字符串或多段数组，统一拍平成文本后再找地址。 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("\n");
  return content ? JSON.stringify(content) : "";
}

/** 只接受带视频扩展名的 HTTPS 链接，不回退到任意链接，避免回复文本诱导下载内网地址。 */
function findVideoUrl(text: string) {
  for (const match of text.match(/https:\/\/[^\s"'<>()[\]]+/g) ?? []) {
    try {
      const url = new URL(match);
      if (/\.(mp4|mov|webm|m3u8)$/i.test(url.pathname)) return url.href;
    } catch {}
  }
}

export default {
  id: "daochengCloud",
  label: "道成云",
  version,
  apiUrl: defaultBaseUrl,
  modelsUrl: `${defaultBaseUrl}/models?type=video`,
  readme: `道成云提供 OpenAI 兼容的模型网关，可调用 Seedance 2.5 等视频模型，费用由平台统一计费。
 \n 👉 前往 [道成云](https://ai.daochengyun.cn/pricing) 获取 API Key，模型 ID 以平台列表为准。`,
  rules,
  models: [
    {
      id: "seedance-2.5",
      label: "Seedance 2.5",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [
        { duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p"] },
      ],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const baseUrl = (this.config.baseUrl?.trim() || defaultBaseUrl).replace(/\/$/, "");

    const image = (input: MediaInput, role: string) => ({ type: "image_url", image_url: { url: mediaUrl(input) }, role });
    const content: Record<string, unknown>[] = [{ type: "text", text: request.prompt }];
    if (request.firstFrame) content.push(image(request.firstFrame, "first_frame"));
    if (request.lastFrame) content.push(image(request.lastFrame, "last_frame"));
    request.images?.forEach((input) => content.push(image(input, "reference_image")));
    request.videos?.forEach((input) => content.push({ type: "video_url", video_url: { url: mediaUrl(input) }, role: "reference_video" }));
    request.audios?.forEach((input) => content.push({ type: "audio_url", audio_url: { url: mediaUrl(input) }, role: "reference_audio" }));

    // ACT: 视频生成同步等待最多 30 分钟；平台若改为异步任务，需要补轮询接口。
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const response = await this.tool.fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // ACT: 时长、分辨率等作为顶层扩展字段透传，字段名沿用 Seedance 常用写法，待平台文档确认；undefined 字段会被 JSON 省略。
      body: JSON.stringify({
        model: request.model,
        messages: [{ role: "user", content }],
        stream: false,
        duration: request.duration,
        resolution: request.resolution,
        ratio: request.ratio,
        generate_audio: request.generateAudio,
        watermark: request.watermark,
        ...request.other,
      }),
      signal,
    });
    if (!response.ok) throw new Error(this.tool.errorMessage(await response.text()) || `请求失败：HTTP ${response.status}`);

    const data = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const text = messageText(data.choices?.[0]?.message?.content);
    const url = findVideoUrl(text);
    if (!url) throw new Error(`回复中未找到视频地址：${this.tool.errorMessage(text.slice(0, 200)) || "空回复"}`);
    return [{ mediaType: "video", type: "url", url }];
  },
} satisfies ProviderDefinition<typeof rules>;
