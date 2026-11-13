import type { NodeVideoRequest } from "@toonflow/nodes-scaffold/runtime";

export type VideoPromptAssistanceInput = {
  directory: string;
  providerId: string;
  modelId: string;
  prompt: string;
  mode: NodeVideoRequest["mode"];
  references?: ({ dataType: "STRING"; value: string } | { dataType: "IMAGE" | "VIDEO"; value: { url: string; mimeType: string } })[];
  duration?: number;
  resolution?: string;
  ratio: string;
  generateAudio?: boolean;
};
export type VideoPromptAssistanceResult = {
  assistanceId?: string;
  activityWarning?: string;
  status: "enhanced" | "clarification";
  originalPrompt: string;
  enhancedPrompt: string;
  changeSummary: string;
  strategyVersion: string;
  clarification?: string;
};

export async function recordPromptAction(input: { directory: string; action: "promptApplied" | "promptRestored"; prompt: string; assistanceId?: string }, headers: Record<string, string> = {}) {
  const response = await fetch("/api/ai/media/tasks/activity", {
    method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1", ...headers },
    body: JSON.stringify(input), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("操作已生效，但操作日志保存失败，请检查服务存储。无需为此重复调用提示词辅助。");
}

export async function enhanceVideoPrompt(input: VideoPromptAssistanceInput, signal: AbortSignal): Promise<VideoPromptAssistanceResult> {
  const response = await fetch("/api/ai/media/tasks/enhancePrompt", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify(input),
    signal,
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("提示词完善服务未返回内容");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error("提示词完善响应过长，请重试");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error("提示词完善服务响应无效，请重试"); }
  if (!response.ok || envelope?.code !== 200) {
    throw new Error(typeof envelope?.message === "string" ? envelope.message.slice(0, 500) : `提示词完善失败（HTTP ${response.status}）`);
  }
  const result = envelope.data;
  const bounded = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
  if (!result || !["enhanced", "clarification"].includes(result.status)
    || !bounded(result.originalPrompt, 10000) || result.originalPrompt !== input.prompt
    || !bounded(result.enhancedPrompt, 10000) || !result.enhancedPrompt.trim()
    || !bounded(result.changeSummary, 500) || !bounded(result.strategyVersion, 100)
    || (result.activityWarning !== undefined && !bounded(result.activityWarning, 500))
    || (result.status === "clarification" && !bounded(result.clarification, 500))) {
    throw new Error("提示词完善服务响应无效，请重试");
  }
  const referenceTokens = (prompt: string) => (prompt.match(/\{\{ref\s+\d+\}\}/g) ?? []).sort();
  if (JSON.stringify(referenceTokens(input.prompt)) !== JSON.stringify(referenceTokens(result.enhancedPrompt))) {
    throw new Error("完善结果改变了引用标记，请重试或直接使用原文。");
  }
  return result;
}
