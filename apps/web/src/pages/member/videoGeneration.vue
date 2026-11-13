<template>
  <el-dialog v-model="visible" title="生成视频" width="min(540px, 94vw)" :closeOnClickModal="false" :closeOnPressEscape="!submitting" :showClose="!submitting">
    <div class="generationContent">
    <p class="generationNote">费用由实例供应商账户承担，实际扣费由供应商结算。</p>
    <p v-if="quota" class="quotaSummary">今日已用 {{ quota.used }} / {{ quota.limit }} 次，剩余 {{ quota.remaining }} 次。北京时间 {{ new Date(quota.resetAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }} 重置。{{ quota.enabled ? '' : '当前项目已停用成员生成。' }}</p>
    <p v-else class="quotaSummary">额度未知，请刷新额度后再提交新任务。</p>
    <p v-if="quotaError" role="alert">{{ quotaError }}</p>
    <el-button v-if="project && !pending && !restored" :loading="quotaLoading" :disabled="submitting || !storageReady" @click="refreshQuota()">刷新额度</el-button>
    <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
    <p v-if="pending" class="recoveryNotice" role="status">项目 {{ pending.projectId }} 的提交结果尚未确认。请求 ID：{{ pending.body.requestId }}。请先查询原任务；重试仍使用同一请求和参数，关闭窗口不会取消后台任务。</p>
    <p v-if="restored" class="recoveryNotice" role="status">已恢复本标签页项目 {{ restored.projectId }} 的提交提醒，请求 ID：{{ restored.requestId }}。可查询原任务或核对并恢复操作；不保存提示词，也不跨设备恢复。</p>
    <el-form v-if="!restored" labelPosition="top" :disabled="loading || submitting || !!pending">
      <el-form-item label="模型">
        <el-select :modelValue="activeModel ? modelIndex : undefined" placeholder="请选择视频模型" aria-label="模型" @update:modelValue="modelIndex = $event">
          <el-option v-for="(model, index) in models" :key="`${model.providerId}/${model.modelId}`" :value="index" :label="`${model.providerLabel} · ${model.label}`" />
        </el-select>
      </el-form-item>
      <p v-if="parameterWarning && !pending && !restored" role="status">{{ parameterWarning }}</p>
      <el-form-item label="提示词">
        <el-input v-model="prompt" type="textarea" :rows="4" :maxlength="10000" showWordLimit aria-label="视频提示词" />
        <el-button :loading="enhancing" :disabled="!canEnhance" @click="enhancePrompt">帮我完善</el-button>
        <el-button :disabled="originalPrompt === undefined || assistantFrozen" @click="restorePrompt">恢复原文</el-button>
        <p>可选辅助会调用管理员配置的文本模型，可能产生费用。请审阅完善结果后再生成。</p>
        <p v-if="enhancementSummary" role="status">{{ enhancementSummary }}</p>
        <p v-if="enhancementError" role="alert">{{ enhancementError }}</p>
      </el-form-item>
      <el-form-item label="时长"><el-select v-model="duration" aria-label="时长"><el-option v-for="value in durations" :key="value" :value="value" :label="`${value} 秒`" /></el-select></el-form-item>
      <el-form-item label="分辨率"><el-select v-model="resolution" aria-label="分辨率"><el-option v-for="value in resolutions" :key="value" :value="value" :label="value" /></el-select></el-form-item>
      <el-form-item v-if="activeModel?.audio === 'optional'" label="生成音频"><el-switch v-model="generateAudio" aria-label="生成音频" /></el-form-item>
      <p v-else-if="activeModel && typeof activeModel.audio === 'boolean'">{{ activeModel.audio ? '此模型始终输出音频。' : '此模型不支持音频输出。' }}</p>
    </el-form>
    </div>
    <template #footer>
      <el-button v-if="pending || restored" :disabled="submitting" @click="queryTask">查询原任务</el-button>
      <el-button v-if="pending || restored" :disabled="submitting || !storageReady" @click="resolveSubmission">核对并恢复操作</el-button>
      <el-button v-if="!restored" :loading="submitting" :disabled="!storageReady || loading || (!pending && (quotaLoading || !quota?.enabled || quota.remaining <= 0 || !!parameterWarning || !prompt.trim()))" type="primary" @click="submit">{{ pending ? '重试确认提交' : '提交生成' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import axios from "axios";
import type { MediaModel, MediaTask } from "@toonflow/tools-scaffold/runtime";

const props = defineProps<{ project?: { id: string; directory: string } }>();
const recoveryProject = ref<{ id: string; directory: string }>();
const project = computed(() => props.project ?? recoveryProject.value);
let disposed = false;
let operationRequest = 0;
let assistanceId: string | undefined;
function logPromptAction(action: "promptApplied" | "promptRestored") {
  const target = project.value;
  if (!target) return;
  void axios.post("/api/ai/media/tasks/activity", { directory: target.directory, action, prompt: prompt.value, assistanceId }, { headers: headers(target.id), timeout: 10000 })
    .catch(() => { if (!disposed && target === project.value) enhancementError.value = "操作已生效，但操作日志保存失败，请检查服务存储。无需为此重复调用提示词辅助。"; });
}
const visible = defineModel<boolean>({ required: true });
const emit = defineEmits<{ submitted: [projectId: string]; pendingChange: [pending: boolean] }>();
const models = ref<MediaModel[]>([]);
const modelIndex = ref(0);
const activeModel = computed(() => models.value[modelIndex.value]);
const durations = computed(() => [...new Set(activeModel.value?.durationResolutionMap?.filter(row => row.resolution.some(item => ["720p", "1080p"].includes(item))).flatMap(row => row.duration) ?? [])].sort((a, b) => a - b));
const duration = ref<number>();
const resolutions = computed(() => ["1080p", "720p"].filter(value => activeModel.value?.durationResolutionMap?.some(row => row.duration.includes(duration.value!) && row.resolution.includes(value))));
const resolution = ref("");
const prompt = ref("");
const generateAudio = ref(false);
const parameterWarning = computed(() => {
  const model = activeModel.value;
  if (!model) return "请先选择视频模型。";
  if (!Array.isArray(model.mode) || !model.mode.length) return "生成模式尚未确认，请联系管理员核实模型配置。";
  if (!model.mode.includes("text")) return "此页面仅支持文生视频，请选择支持该模式的模型。";
  if (model.audio !== true && model.audio !== false && model.audio !== "optional") return "音频能力尚未确认，请联系管理员核实模型配置。";
  if (!durations.value.length) return "尚未配置可用的720p或1080p时长组合，请联系管理员核实。";
  if (!durations.value.includes(duration.value!) || !resolutions.value.includes(resolution.value)) return "请选择模型支持的时长与分辨率组合。";
  return "";
});
const loading = ref(false);
const submitting = ref(false);
const errorMessage = ref("");
type Quota = { limit: number; used: number; remaining: number; resetAt: number; enabled: boolean };
const quota = ref<Quota>();
const quotaLoading = ref(false);
const quotaError = ref("");
let quotaRequest = 0;
type Submission = { projectId: string; body: { directory: string; mediaType: "video"; requestId: string; providerId: string; modelId: string; prompt: string; duration: number; resolution: string; ratio: string; generateAudio: boolean; mode: "text" } };
const pending = ref<Submission>();
type Recovery = { version: 1; projectId: string; directory: string; requestId: string };
const restored = ref<Recovery>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageReady = ref(false);
let accountId = "";
let storageKey = "";
async function readAccount() {
  const { data } = await axios.get<{ code: number; data: { id: string } }>("/api/auth/session", { timeout: 15000 });
  if (data.code !== 200 || typeof data.data?.id !== "string" || !data.data.id || data.data.id.length > 256) throw new Error("无法确认当前登录账号");
  return data.data.id;
}
async function verifyAccount() {
  const id = await readAccount();
  if (disposed) throw new Error("页面已关闭，请重新核对提交记录");
  if (id === accountId) return;
  cancelEnhancement();
  originalPrompt.value = undefined;
  storageReady.value = false;
  prompt.value = "";
  errorMessage.value = "登录账号已变化，请刷新页面后继续";
  throw new Error(errorMessage.value);
}
onMounted(async () => {
  try {
    accountId = await readAccount();
    if (disposed) return;
    storageKey = `toonflow.memberVideo.${accountId}`;
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      if (raw.length > 6000) throw new Error("待确认提交记录无效，请保留本标签页并联系管理员");
      const value = JSON.parse(raw);
      if (value?.version !== 1 || typeof value.projectId !== "string" || !uuidPattern.test(value.projectId) || typeof value.directory !== "string" || !value.directory || value.directory.length > 4096 || typeof value.requestId !== "string" || !uuidPattern.test(value.requestId)) throw new Error("待确认提交记录无效，请保留本标签页并联系管理员");
      restored.value = { version: 1, projectId: value.projectId, directory: value.directory, requestId: value.requestId };
      recoveryProject.value = { id: value.projectId, directory: value.directory };
    }
    storageReady.value = true;
  } catch (error) {
    if (disposed) return;
    errorMessage.value = error instanceof Error ? error.message : "无法读取提交提醒";
    emit("pendingChange", true);
  }
});
watch([pending, restored], () => emit("pendingChange", !!pending.value || !!restored.value));
watch([visible, storageReady, () => project.value?.id, () => project.value?.directory], () => {
  ++operationRequest;
  submitting.value = false;
}, { flush: "sync" });
onBeforeUnmount(() => { disposed = true; ++operationRequest; ++quotaRequest; });
const headers = (id: string) => ({ "x-toonflow-workspace": "1", "x-toonflow-project-id": id, "x-toonflow-user-id": accountId });
// ACT: 辅助草稿仅保留在当前组件内，不进入提交恢复记录。
const enhancing = ref(false);
const originalPrompt = ref<string>();
const enhancementSummary = ref("");
const enhancementError = ref("");
let enhancementRequest = 0;
let enhancementController: AbortController | undefined;
const assistantFrozen = computed(() => !visible.value || !storageReady.value || loading.value || submitting.value || !!pending.value || !!restored.value);
const canEnhance = computed(() => !assistantFrozen.value && !enhancing.value && !!project.value && !parameterWarning.value && !!prompt.value.trim() && prompt.value.length <= 10000);
function cancelEnhancement() {
  ++enhancementRequest;
  enhancementController?.abort();
  enhancementController = undefined;
  enhancing.value = false;
  enhancementSummary.value = "";
  enhancementError.value = "";
}
function enhancementSnapshot() {
  return JSON.stringify([project.value?.id, project.value?.directory, activeModel.value, duration.value, resolution.value, generateAudio.value, prompt.value, visible.value, storageReady.value, submitting.value, !!pending.value, !!restored.value]);
}
watch(enhancementSnapshot, cancelEnhancement, { flush: "sync" });
watch([() => project.value?.id, () => project.value?.directory, visible, storageReady], () => { originalPrompt.value = undefined; }, { flush: "sync" });
onBeforeUnmount(cancelEnhancement);
function restorePrompt() {
  if (assistantFrozen.value || originalPrompt.value === undefined) return;
  const original = originalPrompt.value;
  cancelEnhancement();
  prompt.value = original;
  logPromptAction("promptRestored");
  originalPrompt.value = undefined;
}
async function enhancePrompt() {
  if (!canEnhance.value || !project.value || !activeModel.value) return;
  cancelEnhancement();
  const request = enhancementRequest;
  const snapshot = enhancementSnapshot();
  const target = { ...project.value };
  const model = activeModel.value;
  const rawPrompt = prompt.value;
  const body = { directory: target.directory, providerId: model.providerId, modelId: model.modelId, prompt: rawPrompt, duration: duration.value, resolution: resolution.value, ratio: "16:9", generateAudio: model.audio === true || (model.audio === "optional" && generateAudio.value) };
  const controller = new AbortController();
  enhancementController = controller;
  enhancing.value = true;
  const current = () => request === enhancementRequest && !controller.signal.aborted && snapshot === enhancementSnapshot() && !assistantFrozen.value;
  try {
    await verifyAccount();
    if (!current()) return;
    const { data } = await axios.post<{ code: number; message: string; data: { assistanceId?: string; activityWarning?: string; status: "enhanced" | "clarification"; enhancedPrompt: string; changeSummary: string; clarification?: string } }>("/api/ai/media/tasks/enhancePrompt", body, { headers: headers(target.id), signal: controller.signal, timeout: 40000 });
    await verifyAccount();
    if (!current()) return;
    if (data.code !== 200) throw new Error(data.message || "完善失败，请重试");
    if (data.data.status === "clarification") {
      enhancementSummary.value = data.data.clarification || "请确认提示词后重试，也可直接生成。";
    } else if (data.data.status === "enhanced" && typeof data.data.enhancedPrompt === "string" && data.data.enhancedPrompt.trim() && data.data.enhancedPrompt.length <= 10000) {
      const original = originalPrompt.value ?? rawPrompt;
      prompt.value = data.data.enhancedPrompt;
      assistanceId = data.data.assistanceId;
      logPromptAction("promptApplied");
      originalPrompt.value = original;
      enhancementSummary.value = data.data.changeSummary;
    } else throw new Error("完善结果无效，请重试");
    if (typeof data.data.activityWarning === "string") enhancementError.value = data.data.activityWarning.slice(0, 500);
  } catch (error) {
    if (current()) enhancementError.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "完善失败，请重试";
  } finally {
    if (request === enhancementRequest) { enhancing.value = false; enhancementController = undefined; }
  }
}
async function refreshQuota(target = project.value, signal?: AbortSignal) {
  const request = ++quotaRequest;
  quota.value = undefined;
  quotaError.value = "";
  if (!target || !storageReady.value || disposed) { quotaLoading.value = false; return false; }
  quotaLoading.value = true;
  try {
    const { data } = await axios.get<{ code: number; message: string; data: Quota }>("/api/ai/media/tasks/quota", {
      params: { directory: target.directory }, headers: headers(target.id), signal, timeout: 15000,
    });
    if (disposed || signal?.aborted || request !== quotaRequest || target.id !== project.value?.id || target.directory !== project.value?.directory) return false;
    if (data.code !== 200) throw new Error(data.message);
    quota.value = data.data;
    return data.data.enabled && data.data.remaining > 0;
  } catch (error) {
    if (!signal?.aborted && request === quotaRequest) quotaError.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "额度读取失败，请刷新额度";
    return false;
  } finally { if (request === quotaRequest) quotaLoading.value = false; }
}
watch(durations, values => { if (!values.includes(duration.value!)) duration.value = values[0]; }, { flush: "sync" });
watch(resolutions, values => { if (!values.includes(resolution.value)) resolution.value = values[0] ?? ""; }, { flush: "sync" });
watch(modelIndex, () => { generateAudio.value = false; });
watch([visible, storageReady, project, pending, restored], async ([opened], _previous, onCleanup) => {
  ++quotaRequest;
  quota.value = undefined;
  quotaLoading.value = false;
  loading.value = false;
  if (!opened || pending.value || restored.value || !project.value || !storageReady.value || disposed) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const target = { ...project.value };
  loading.value = true;
  errorMessage.value = "";
  models.value = [];
  try {
    const [{ data }] = await Promise.all([
      axios.get<{ code: number; message: string; data: MediaModel[] }>("/api/ai/media/tasks/models", { params: { directory: target.directory }, headers: headers(target.id), signal: controller.signal, timeout: 15000 }),
      refreshQuota(target, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    if (data.code !== 200) throw new Error(data.message);
    models.value = data.data.filter(model => model.type === "video");
    modelIndex.value = 0;
    if (!models.value.length) errorMessage.value = "当前项目没有支持此生成规格的授权模型。";
  } catch (error) { if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : "模型加载失败"; }
  finally { if (!controller.signal.aborted) loading.value = false; }
}, { immediate: true });

function openSubmitted(projectId: string) {
  sessionStorage.removeItem(storageKey);
  restored.value = undefined;
  pending.value = undefined;
  prompt.value = "";
  visible.value = false;
  emit("submitted", projectId);
}

function submissionRecord(): Recovery | undefined {
  return restored.value ?? (pending.value ? {
    version: 1, projectId: pending.value.projectId, directory: pending.value.body.directory, requestId: pending.value.body.requestId,
  } : undefined);
}

function startOperation() {
  const request = ++operationRequest;
  submitting.value = true;
  errorMessage.value = "";
  return () => !disposed && request === operationRequest && storageReady.value;
}

function matchesTask(task: MediaTask | undefined, submission: Recovery) {
  return task?.id === submission.requestId && task.projectId === submission.projectId && task.createdBy?.id === accountId;
}

async function queryTask() {
  const submission = submissionRecord();
  if (disposed || !visible.value || submitting.value || !submission || !storageReady.value) return;
  const current = startOperation();
  try {
    await verifyAccount();
    if (!current()) return;
    const { data } = await axios.get<{ code: number; message: string; data: MediaTask }>("/api/ai/media/tasks/get", {
      params: { directory: submission.directory, id: submission.requestId },
      headers: headers(submission.projectId), timeout: 15000,
    });
    if (!current()) return;
    await verifyAccount();
    if (!current()) return;
    if (data.code !== 200 || !matchesTask(data.data, submission)) {
      throw new Error("尚未确认原任务，请保留请求 ID 后再次查询");
    }
    openSubmitted(submission.projectId);
  } catch (error) {
    if (!current()) return;
    errorMessage.value = axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.status === 404 ? "暂未找到原任务，可能仍在提交中或项目权限已变化。请保留原请求后重查，不要新建重复任务。"
        : error.response?.data?.message || error.message
      : error instanceof Error ? error.message : "任务查询失败";
  } finally { if (current()) submitting.value = false; }
}

async function resolveSubmission() {
  const submission = submissionRecord();
  if (disposed || !visible.value || submitting.value || !submission || !storageReady.value) return;
  const current = startOperation();
  try {
    await verifyAccount();
    if (!current()) return;
    const { data } = await axios.post<{ code: number; message: string; data:
      { state: "existing"; task: MediaTask } | { state: "closed"; requestId: string; projectId: string; actorId: string }
    }>("/api/ai/media/tasks/resolveSubmission", { directory: submission.directory, requestId: submission.requestId }, {
      headers: headers(submission.projectId), timeout: 15000,
    });
    if (!current()) return;
    await verifyAccount();
    if (!current()) return;
    if (data.code !== 200) throw new Error(data.message || "核对失败，请保留提交提醒后重试");
    if (data.data?.state === "existing" && matchesTask(data.data.task, submission)) {
      openSubmitted(submission.projectId);
    } else if (data.data?.state === "closed" && data.data.requestId === submission.requestId && data.data.projectId === submission.projectId && data.data.actorId === accountId) {
      // 服务端已持久关闭旧 UUID；只有提醒清理成功后才允许新提交。
      sessionStorage.removeItem(storageKey);
      recoveryProject.value = { id: submission.projectId, directory: submission.directory };
      pending.value = undefined;
      restored.value = undefined;
    } else {
      throw new Error("核对结果与原请求不一致，请保留提交提醒后重试");
    }
  } catch (error) {
    if (current()) errorMessage.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "核对失败，请保留提交提醒后重试";
  } finally { if (current()) submitting.value = false; }
}

async function submit() {
  cancelEnhancement();
  if (disposed || !visible.value || submitting.value || restored.value || !storageReady.value || !project.value) return;
  const target = { ...project.value };
  const current = startOperation();
  try {
    await verifyAccount();
    if (!current()) return;
    const model = activeModel.value;
    if (!pending.value) {
      const allowed = await refreshQuota(target);
      if (!current()) return;
      if (!allowed) throw new Error("无法提交新任务：请确认当前项目已启用且每日额度充足，并刷新额度。");
      await verifyAccount();
      if (!current()) return;
      if (parameterWarning.value) { errorMessage.value = parameterWarning.value; return; }
      if (!model || !prompt.value.trim() || prompt.value.length > 10000) return;
      pending.value = { projectId: target.id, body: { directory: target.directory, mediaType: "video", requestId: crypto.randomUUID(), providerId: model.providerId, modelId: model.modelId, prompt: prompt.value.trim(), duration: duration.value!, resolution: resolution.value, ratio: "16:9", generateAudio: model.audio === true || (model.audio === "optional" && generateAudio.value), mode: "text" } };
    }
    const submission = pending.value;
    const record = submissionRecord()!;
    try { sessionStorage.setItem(storageKey, JSON.stringify(record)); }
    catch { throw new Error("无法保存提交提醒，未发送生成请求。请检查浏览器存储后重试。"); }
    const { status, data } = await axios.post("/api/ai/media/tasks/create", submission.body, { headers: headers(submission.projectId), timeout: 30000 });
    if (!current()) return;
    await verifyAccount();
    if (!current()) return;
    if (status !== 202 || data.code !== 200 || !matchesTask(data.data, record)) throw new Error("提交结果未确认，请查询原任务或核对并恢复操作");
    openSubmitted(submission.projectId);
  } catch (error) {
    if (!current()) return;
    errorMessage.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "提交失败";
  } finally { if (current()) submitting.value = false; }
}
</script>

<style scoped lang="scss">
.generationContent {
  line-height: 1.65;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  .generationNote { color: var(--el-text-color-secondary); margin-top: 0; font-size: 13px; }
  .quotaSummary { padding: 12px 16px; border-radius: 10px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); }
  .recoveryNotice { padding: 12px 16px; border-radius: 10px; background: var(--el-color-warning-light-9); border-left: 3px solid var(--el-color-warning); color: var(--el-text-color-primary); }
  [role="alert"] { padding: 10px 12px; border-radius: 8px; background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
  .el-button { min-height: 40px; }
  .el-form {
    margin-top: 20px;
    .el-select { width: 100%; }
    .el-form-item {
      margin-bottom: 20px;
      .el-button { margin-top: 8px; }
      p { margin: 8px 0 0; font-size: 13px; line-height: 1.6; }
    }
    > [role="status"] { margin: -8px 0 16px; padding: 10px 12px; background: var(--el-fill-color-light); border-radius: 8px; }
  }
}
</style>
