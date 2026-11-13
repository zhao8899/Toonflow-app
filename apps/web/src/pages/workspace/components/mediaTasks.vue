<template>
  <el-drawer v-model="visible" title="生成任务" size="min(680px, 100vw)" appendToBody>
    <div class="mediaTasks">
      <p class="billingNote">费用由所选供应商结算。取消、断线或服务中断不代表上游已取消或退款；再次生成前请核对原任务。</p>
      <p class="billingNote">这里保留原始生成结果；局部重绘的蒙版合成等后续编辑结果请在画布中查看。</p>
      <p class="billingNote">生成参数、提示词辅助和操作记录用于质量分析。旧任务未记录的内容不会补造。</p>
      <details v-if="canManageCosts" ref="diagnosticsPanel" class="taskDiagnostics">
        <summary>任务日志与排查</summary>
      <div class="activityToolbar">
        <el-date-picker v-model="activityDay" type="date" valueFormat="YYYY-MM-DD" aria-label="日志日期（UTC）" :clearable="false" />
        <el-button :loading="exportingActivity" @click="exportActivity">导出当日操作日志（UTC）</el-button>
      </div>
      <div v-if="canManageCosts" ref="taskLogsPanel" class="taskLogs">
        <el-date-picker v-model="logRange" type="daterange" valueFormat="YYYY-MM-DD" startPlaceholder="开始日期（UTC）" endPlaceholder="结束日期（UTC）" aria-label="任务日志日期范围（UTC）" :clearable="false" />
        <el-input v-model="logTaskId" placeholder="粘贴任务 ID" aria-label="日志任务ID" @keyup.enter="findTaskLogs()" />
        <el-button :loading="logsLoading" @click="findTaskLogs()">查找任务日志</el-button>
        <el-button v-if="logsLoading" @click="stopTaskLogs">停止查询</el-button>
        <p class="billingNote">一次查询最多7天（UTC），默认最近7天；以下时间按本地时区显示。未找到不代表任务未提交，勿直接重复生成。</p>
        <p v-if="logsError" class="taskError" role="alert">{{ logsError }}</p>
        <template v-if="logsLoaded">
          <p role="status">查询范围：{{ logRange?.[0] }} 至 {{ logRange?.[1] }}（UTC）。{{ taskLogs.length ? `找到 ${taskLogs.length} 条记录（按时间顺序）` : '范围内未找到该任务记录。请核对日期和任务 ID。' }}</p>
          <p v-if="logsWarning" class="taskError" role="alert">{{ logsWarning }}</p>
          <p class="billingNote">仅查询所选范围内当前可读日志，不代表任务全部历史；旧版本、拒写或崩溃期间可能没有记录。</p>
          <ol>
            <li v-for="(entry, index) in taskLogs" :key="index">
              {{ new Date(entry.recordedAt).toLocaleString() }} · {{ logStage(entry) }}
              <span v-if="entry.kind === 'mediaTask'"> · {{ statusLabels[entry.status as MediaTask['status']] ?? '状态未知' }}</span>
              <span v-if="entry.providerTaskId"> · 供应商任务：{{ entry.providerTaskId }}</span>
            </li>
          </ol>
        </template>
      </div>
      </details>
      <template v-if="canManageCosts">
        <p v-if="activityError" class="taskError" role="alert">{{ activityError }}</p>
        <p v-else-if="activityStatus?.blocked" class="taskError" role="alert">操作日志已停止新增留存，现有日志保留。停止期间的新日志未继续留存。{{ activityReason(activityStatus.reason) }}</p>
        <p v-else-if="activityStatus?.lastRejectedReason" class="taskError" role="alert">最近一次日志拒绝原因：{{ activityReason(activityStatus.lastRejectedReason) }} 这是单次拒绝历史，当前未报告整体停止；被拒日志未保存。</p>
        <p v-if="activityStatus" class="billingNote">日志占用 {{ (activityStatus.bytes / 1024 / 1024).toFixed(1) }} / {{ (activityStatus.limits.maxBytes / 1024 / 1024).toFixed(1) }} MB，{{ activityStatus.files }} / {{ activityStatus.limits.maxFiles }} 个文件；本进程启动以来拒绝留存 {{ activityStatus.rejected }} 次（非长期账本）。</p>
        <p v-else-if="!activityError" class="billingNote">日志容量状态读取中。</p>
      </template>
      <div class="taskFilters">
        <el-select v-model="mediaTypeFilter" placeholder="全部媒体" clearable aria-label="媒体类型">
          <el-option v-for="(label, value) in mediaLabels" :key="value" :label="label" :value="value" />
        </el-select>
        <el-select v-model="statusFilter" placeholder="全部生成状态" clearable aria-label="生成状态">
          <el-option v-for="(label, value) in statusLabels" :key="value" :label="label" :value="value" />
        </el-select>
        <el-select v-model="reviewFilter" placeholder="全部审核状态" clearable aria-label="审核状态">
          <el-option label="待审核" value="pending" />
          <el-option label="需要修改" value="changesRequested" />
          <el-option label="审核通过" value="approved" />
        </el-select>
      </div>
      <p v-if="reviewFilter === 'pending'" class="billingNote">待审核仅包含已结束、有保存结果且尚未提交审核的任务。</p>
      <p v-if="canManageCosts" class="billingNote">成本导出包含当前项目全部任务，不受当前筛选影响；未核对金额保留为未知。</p>
      <div class="taskToolbar">
        <span>{{ corruptCount ? '可读取的' : '' }}{{ hasFilters ? '符合条件' : '共' }} {{ total }} 个任务</span>
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-button v-if="canManageCosts" :loading="exportingCosts" @click="exportCosts">导出项目成本 JSON</el-button>
      </div>
      <p v-if="loadError" class="taskError" role="alert">{{ loadError }}</p>
      <p v-if="reviewNotice" role="status">{{ reviewNotice }}</p>
      <p v-if="downloadNotice && !previewVisible" :class="{ taskError: downloadFailed }" :role="downloadFailed ? 'alert' : 'status'">{{ downloadNotice }}</p>
      <p v-if="corruptCount" class="taskError" role="alert">
        任务列表不完整：项目中有 {{ corruptCount }} 条损坏记录，未计入上述任务数量，也无法判断其是否符合筛选条件。请联系管理员检查原始记录；成员生成额度与项目成本导出将继续阻止处理，避免漏算。
        损坏任务 ID（最多显示 10 个）：{{ corruptTaskIds.join('、') }}。
      </p>
      <p v-if="!loadError && !corruptCount && !loading && !tasks.length">{{ hasFilters ? '暂无符合筛选条件的任务' : '当前项目暂无生成任务' }}</p>
      <article v-for="task in tasks" :key="task.id" class="taskItem" :data-status="task.status">
        <div class="taskHeader">
          <strong>{{ mediaLabels[task.mediaType] }} · {{ statusLabels[task.status] }}</strong>
          <el-button v-if="userRole === 'admin' && task.canResume" size="small" :loading="resuming === task.id" @click="resume(task)">续查原任务</el-button>
          <el-button v-if="canCancel(task)" size="small" :loading="cancelling === task.id" @click="cancel(task)">取消任务</el-button>
        </div>
        <p>{{ task.providerId }} / {{ task.modelId }}</p>
        <p class="taskMeta">{{ new Date(task.createdAt).toLocaleString() }}</p>
        <p v-if="task.completedAt && task.timeline?.length" class="taskMeta">从提交到结束：{{ Math.max(0, Math.round((task.completedAt - task.createdAt) / 1000)) }} 秒（含等待及续查）</p>
        <details v-if="task.request" class="taskDetails">
          <summary>查看生成提示词与参数</summary>
          <p class="promptText">{{ task.request.prompt }}</p>
          <pre>{{ JSON.stringify(Object.fromEntries(Object.entries(task.request).filter(([key]) => key !== 'prompt')), null, 2) }}</pre>
        </details>
        <p v-else class="taskMeta">历史任务未保存提示词和参数快照。</p>
        <p v-if="task.createdBy" class="taskMeta">发起人：{{ task.createdBy.username }}</p>
        <p v-if="task.billingOwner === 'instance'" class="taskMeta">付费归属：实例供应商账户</p>
        <p class="taskMeta">任务 ID：{{ task.id }}</p>
        <el-button v-if="canManageCosts" size="small" @click="openTaskLogs(task)">查看流程日志</el-button>
        <p v-if="task.providerTaskId" class="taskMeta">供应商任务 ID：{{ task.providerTaskId }}</p>
        <p>{{ billingLabels[task.billingState] }}</p>
        <el-button v-if="canManageCosts && !['queued', 'running', 'saving', 'cancelling'].includes(task.status)" size="small" @click="costTaskId = task.id; costVisible = true">成本核对</el-button>
        <p v-if="task.error" class="taskError">{{ task.error }}</p>
        <div v-if="task.files.length" class="taskFiles">
          <div v-for="file in task.files" :key="file.path" class="taskFile">
            <span class="fileName">{{ file.path.split('/').pop() }}</span>
          <el-button size="small" :loading="previewLoading === file.path" :aria-label="`预览 ${file.path.split('/').pop()}`" @click="preview(task.id, file)">预览</el-button>
          <el-button text type="primary" :aria-label="`下载 ${file.path.split('/').pop()}`"
            :loading="downloading === `${task.id}:${file.path}`" :disabled="!!downloading" @click="download(task.id, file)">
            下载
          </el-button>
          </div>
        </div>
        <div v-if="task.review" class="taskReview">
          <strong>{{ task.review.decision === 'approved' ? '审核通过' : '需要修改' }}</strong>
          <p class="taskMeta">{{ task.review.reviewer?.username ?? '本地操作者（未认证）' }} · {{ new Date(task.review.reviewedAt).toLocaleString() }} · 第 {{ task.review.revision }} 次审核</p>
          <p class="reviewComment">{{ task.review.comment }}</p>
          <el-button size="small" @click="historyTaskId = task.id; historyVisible = true">审核历史</el-button>
        </div>
        <el-button v-if="task.files.length && !['queued', 'running', 'saving', 'cancelling'].includes(task.status)" size="small" @click="openReview(task)">
          {{ task.review ? '更新审核' : '审核结果' }}
        </el-button>
      </article>
      <div class="taskPagination">
        <el-button :disabled="offset === 0 || loading" @click="offset -= pageSize">上一页</el-button>
        <span>{{ Math.floor(offset / pageSize) + 1 }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
        <el-button :disabled="offset + pageSize >= total || loading" @click="offset += pageSize">下一页</el-button>
      </div>
    </div>
  </el-drawer>
  <el-dialog v-model="previewVisible" title="生成结果预览" width="min(900px, 95vw)" appendToBody destroyOnClose>
    <div class="mediaPreview">
      <p v-if="previewLoading" role="status">正在读取预览文件…</p>
      <p v-if="previewError" class="previewError" role="alert">{{ previewError }}</p>
      <video v-if="previewType === 'video' && previewUrl" :key="previewUrl" :src="previewUrl" controls playsinline preload="metadata" aria-label="生成视频预览" @error="mediaError" />
      <audio v-else-if="previewType === 'audio' && previewUrl" :key="previewUrl" :src="previewUrl" controls aria-label="生成音频预览" @error="mediaError" />
      <img v-else-if="previewUrl" :key="previewUrl" :src="previewUrl" alt="生成图片预览" @error="mediaError" />
      <p v-if="downloadNotice" :class="{ previewError: downloadFailed }" :role="downloadFailed ? 'alert' : 'status'">{{ downloadNotice }}</p>
    </div>
    <template #footer>
      <el-button v-if="previewTarget && previewError" :disabled="!!previewLoading" @click="preview(previewTarget.taskId, previewTarget.file)">重新加载预览</el-button>
      <el-button v-if="previewTarget" :loading="!!downloading" :disabled="!!downloading" @click="download(previewTarget.taskId, previewTarget.file)">下载原文件</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="reviewVisible" title="审核生成结果" width="min(520px, 95vw)" appendToBody
    :closeOnClickModal="!reviewSaving" :closeOnPressEscape="!reviewSaving" :showClose="!reviewSaving">
    <p>审核针对本任务的全部原始生成结果，不包含画布后续编辑。保留最近 100 次审核记录。</p>
    <el-form labelPosition="top">
      <el-form-item label="审核结论">
        <el-radio-group v-model="reviewDecision" :disabled="reviewSaving || reviewLoading" aria-label="审核结论">
          <el-radio value="approved">通过</el-radio>
          <el-radio value="changesRequested">需要修改</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="审核意见">
        <el-input v-model="reviewComment" type="textarea" :rows="4" :maxlength="2000" showWordLimit :disabled="reviewSaving || reviewLoading" aria-label="审核意见" />
      </el-form-item>
    </el-form>
    <p v-if="reviewError" role="alert">{{ reviewError }}</p>
    <template #footer>
      <el-button :disabled="reviewSaving" @click="reviewVisible = false">取消</el-button>
      <el-button :disabled="reviewSaving || reviewLoading" :loading="reviewLoading" @click="reloadReview">读取最新审核</el-button>
      <el-button type="primary" :loading="reviewSaving" :disabled="reviewLoading || reviewNeedsReload" @click="saveReview">保存审核</el-button>
    </template>
  </el-dialog>
  <mediaReviewHistory v-model="historyVisible" :directory="directory" :taskId="historyTaskId" :projectId="workspaceStore.project?.serverProjectId" />
  <mediaTaskCost v-if="canManageCosts" v-model="costVisible" :directory="directory" :taskId="costTaskId" :projectId="projectId" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import type { GeneratedMedia, MediaTask, MediaTaskFilters } from "@toonflow/tools-scaffold/runtime";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import saveFile from "@/lib/saveFile";
import { authRequired, userRole } from "@/lib/auth";
import mediaReviewHistory from "./mediaReviewHistory.vue";
import mediaTaskCost from "./mediaTaskCost.vue";

const visible = defineModel<boolean>({ default: false });
const activityDay = ref(new Date().toISOString().slice(0, 10));
const exportingActivity = ref(false);
const logTaskId = ref("");
const logRange = ref<[string, string]>([new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)]);
const logsWarning = ref("");
const taskLogsPanel = ref<HTMLElement>();
const diagnosticsPanel = ref<HTMLDetailsElement>();
const logsLoading = ref(false);
const logsLoaded = ref(false);
const logsError = ref("");
type TaskLog = { recordedAt: number; kind: string; stage?: string; status?: string | number; providerTaskId?: string };
const taskLogs = ref<TaskLog[]>([]);
let logsController: AbortController | undefined;
function clearTaskLogs() {
  logsController?.abort(); logsController = undefined;
  taskLogs.value = []; logsLoaded.value = false; logsLoading.value = false; logsError.value = ""; logsWarning.value = "";
}
function stopTaskLogs() {
  clearTaskLogs();
  logsError.value = "已停止查询，不影响生成任务。可调整范围后重新查询。";
}
function logStage(entry: TaskLog) {
  if (entry.kind === "http") return `操作请求 · HTTP ${entry.status ?? '未知'}`;
  return ({ statusChanged: "生成状态更新", statusSnapshot: "历史任务快照", submissionReused: "复用原任务，未重新生成",
    providerTaskReceived: "已取得供应商任务 ID", recoveryStarted: "开始续查原任务", executionFailed: "执行失败，请核对原任务与费用",
    cancellationObserved: "已停止本地处理，上游费用待核对", persistenceFailed: "任务记录保存失败，请检查存储；不要重复生成" } as Record<string, string>)[entry.stage ?? ""] ?? "其他任务记录";
}
async function findTaskLogs() {
  clearTaskLogs();
  if (!canManageCosts.value || !visible.value) return;
  const taskId = logTaskId.value.trim();
  const [startDay, endDay] = logRange.value ?? [];
  const days = Date.parse(endDay ?? "") - Date.parse(startDay ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId) || !Number.isFinite(days) || days < 0 || days > 6 * 86400000) {
    logsError.value = "请填写完整任务 ID，选择先后顺序正确、最多7天的日期范围。"; return;
  }
  const controller = new AbortController(); logsController = controller; logsLoading.value = true;
  try {
    const { data } = await axios.get("/api/activity/export", { params: { startDay, endDay, taskId },
      headers: { "x-toonflow-workspace": "1" }, signal: controller.signal, timeout: 15000 });
    if (controller.signal.aborted || controller !== logsController) return;
    const result = data.data;
    if (data.code !== 200 || !Array.isArray(result?.events) || typeof result.incomplete !== "boolean"
      || ![result.missingDays, result.failedDays, result.unscannedDays].every(value => Array.isArray(value) && value.every(day => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)))
      || !Number.isSafeInteger(result.invalidFiles) || result.invalidFiles < 0 || typeof result.limitReached !== "boolean") throw new Error();
    taskLogs.value = data.data.events;
    const warnings = [result.missingDays.length ? `没有日志目录的日期：${result.missingDays.join('、')}` : "",
      result.failedDays.length ? `无法读取的日期：${result.failedDays.join('、')}` : "",
      result.invalidFiles ? `${result.invalidFiles} 条损坏、过大或无法读取的记录已跳过` : "",
      result.limitReached ? `达到扫描上限（10000目录条目/20MB/2000结果），未扫描完的日期：${result.unscannedDays.join('、')}；请缩小日期范围` : "",
      result.timedOut === true ? `查询达到10秒时限，未扫描完的日期：${result.unscannedDays.join('、')}；请缩小范围后重试` : ""];
    if (result.incomplete || warnings.some(Boolean)) logsWarning.value = `结果可能不完整。${warnings.filter(Boolean).join('；')}。不能据此判断未生成或未扣费。`;
    logsLoaded.value = true;
  } catch {
    if (!controller.signal.aborted && controller === logsController) logsError.value = "日志未能读取，不能据此判断任务状态。请重试；当日日志过大或损坏时联系管理员检查。";
  } finally { if (controller === logsController) logsLoading.value = false; }
}
async function openTaskLogs(task: MediaTask) {
  if (diagnosticsPanel.value) diagnosticsPanel.value.open = true;
  logTaskId.value = task.id;
  const end = Date.parse(new Date(task.updatedAt).toISOString().slice(0, 10));
  const start = Math.max(Date.parse(new Date(task.createdAt ?? task.updatedAt).toISOString().slice(0, 10)), end - 6 * 86400000);
  logRange.value = [new Date(start).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10)];
  taskLogsPanel.value?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  await findTaskLogs();
}
watch([logTaskId, logRange], clearTaskLogs, { flush: "sync", deep: true });
onBeforeUnmount(clearTaskLogs);
type ActivityStatus = {
  bytes: number; files: number;
  limits: { maxBytes: number; maxFiles: number; maxRecordBytes: number; minFreeBytes: number };
  availableBytes: number | null; blocked: boolean; reason: string | null;
  rejected: number; lastRejectedAt: number | null; lastScannedAt: number | null; lastRejectedReason: string | null;
};
const activityStatus = ref<ActivityStatus>();
const activityError = ref("");
function activityReason(reason: string | null) {
  switch (reason) {
    case "日志容量配置无效，须使用正安全整数": return "日志容量配置无效，请联系管理员将容量配置设为正安全整数。";
    case "日志容量扫描失败或存在不安全链接，已停止新增日志": return "日志目录扫描失败或存在不安全链接，请联系管理员检查存储目录。";
    case "无法检查日志磁盘剩余空间，已停止新增日志": return "无法检查日志磁盘剩余空间，请联系管理员检查存储状态及访问权限。";
    case "日志存储写入失败，未确认保存": return "日志存储写入失败，请联系管理员检查存储状态及访问权限。";
    case "磁盘剩余空间低于日志保留阈值":
    case "日志文件数已达上限":
    case "日志总字节数已达上限":
    case "日志剩余字节配额不足以保存本条记录":
    case "写入本条日志将低于磁盘保留阈值": return `${reason}。请联系管理员归档或扩容后检查状态。`;
    case "单条日志字节数超过上限": return "单条日志过大，请联系管理员检查记录大小与单条容量配置。";
    case "日志内容无法序列化":
    case "请求操作日志构造失败，未确认保存": return "本条日志内容处理失败，请联系管理员检查日志记录功能。";
    default: return "请管理员检查存储或容量配置。";
  }
}
const previewVisible = ref(false), previewUrl = ref(""), previewType = ref(""), previewLoading = ref("");
const previewError = ref("");
const previewTarget = ref<{ taskId: string; file: GeneratedMedia }>();
let previewResource: ReturnType<ReturnType<typeof useWorkspaceFiles>["acquireUrl"]> | undefined;
let previewController: AbortController | undefined;
let downloadController: AbortController | undefined;
let disposed = false;
function closePreview() {
  previewController?.abort(); previewController = undefined;
  previewResource?.release(); previewResource = undefined;
  previewUrl.value = ""; previewVisible.value = false; previewLoading.value = "";
  previewError.value = ""; previewTarget.value = undefined;
}
onBeforeUnmount(() => { disposed = true; closePreview(); downloadController?.abort(); });
watch(previewVisible, value => { if (!value) closePreview(); }, { flush: "sync" });
function mediaError(event: Event) {
  const source = event.currentTarget as HTMLMediaElement | HTMLImageElement;
  if (!previewVisible.value || !previewUrl.value || source.src !== previewUrl.value) return;
  previewError.value = "无法加载或解码此文件，可能是文件损坏或当前浏览器不支持该格式。可重新加载预览，或下载原文件使用其他播放器查看；不会重新生成。";
}
async function preview(taskId: string, file: GeneratedMedia) {
  const cwd = directory.value;
  if (!cwd || disposed || !visible.value) return;
  closePreview();
  previewTarget.value = { taskId, file: { ...file } };
  previewVisible.value = true;
  previewLoading.value = file.path;
  if (!downloading.value) downloadNotice.value = "";
  const controller = new AbortController();
  previewController = controller;
  try {
    const resource = useWorkspaceFiles(cwd, projectId.value).acquireUrl(file.path, file.mimeType, { signal: controller.signal, timeout: 30000 });
    previewResource = resource;
    const url = await resource.url;
    if (controller.signal.aborted || previewController !== controller) return;
    previewUrl.value = url; previewType.value = file.mediaType;
  } catch (cause) {
    if (!controller.signal.aborted && previewController === controller) previewError.value = `预览文件读取失败：${message(cause)}。可重新加载或下载原文件。`;
  } finally { if (previewController === controller) previewLoading.value = ""; }
}
async function exportActivity() {
  if (!activityDay.value || exportingActivity.value) return;
  exportingActivity.value = true;
  const day = activityDay.value;
  try {
    const { data } = await axios.get("/api/activity/export", { params: { day }, headers: { "x-toonflow-workspace": "1" }, timeout: 30000 });
    if (data.code !== 200) throw new Error(data.message);
    await saveFile(new Blob([JSON.stringify(data.data, null, 2)], { type: "application/json" }), `activity${day.replaceAll('-', '')}.json`);
  } catch (cause) { ElMessage.error(message(cause)); }
  finally { exportingActivity.value = false; }
}
const workspaceStore = useWorkspaceStore();
const directory = computed(() => workspaceStore.project?.directory);
const projectId = computed(() => workspaceStore.project?.serverProjectId);
const tasks = ref<MediaTask[]>([]);
const total = ref(0);
const corruptCount = ref(0);
const corruptTaskIds = ref<string[]>([]);
const offset = ref(0);
const mediaTypeFilter = ref<MediaTaskFilters["mediaType"] | "">("");
const statusFilter = ref<MediaTaskFilters["status"] | "">("");
const reviewFilter = ref<MediaTaskFilters["reviewState"] | "">("");
const hasFilters = computed(() => !!(mediaTypeFilter.value || statusFilter.value || reviewFilter.value));
const pageSize = 30;
const loading = ref(false);
const loadError = ref("");
const cancelling = ref("");
const resuming = ref("");
const downloading = ref("");
const downloadNotice = ref("");
const downloadFailed = ref(false);
const reviewVisible = ref(false);
const reviewSaving = ref(false);
const reviewError = ref("");
const reviewLoading = ref(false), reviewNeedsReload = ref(false), reviewNotice = ref("");
const historyVisible = ref(false);
const historyTaskId = ref("");
const costVisible = ref(false), costTaskId = ref(""), exportingCosts = ref(false);
const canManageCosts = computed(() => !authRequired.value || userRole.value === "admin");
const reviewDecision = ref<"approved" | "changesRequested">("approved");
const reviewComment = ref("");
let reviewTarget: { directory: string; id: string; revision: number; projectId?: string } | undefined;
let reviewController: AbortController | undefined;
function clearReview() {
  reviewController?.abort(); reviewController = undefined;
  reviewTarget = undefined; reviewSaving.value = false; reviewLoading.value = false; reviewNeedsReload.value = false;
}
watch(reviewVisible, value => { if (!value) clearReview(); }, { flush: "sync" });
onBeforeUnmount(clearReview);
function taskHeaders(cwd: string) {
  const project = workspaceStore.project;
  return {
    "x-toonflow-workspace": "1",
    ...(project?.directory === cwd && project.serverProjectId ? { "x-toonflow-project-id": project.serverProjectId } : {}),
  };
}
let lifetime: AbortController | undefined;
const mediaLabels = { image: "图片", video: "视频", audio: "音频" };
const statusLabels = {
  queued: "准备中", running: "生成中", saving: "保存中", cancelling: "取消中", succeeded: "已完成",
  failed: "未完成", cancelled: "已停止本地处理", interrupted: "服务中断",
};
const billingLabels = {
  notSubmitted: "尚未提交供应商生成", providerManaged: "结果已保存，实际费用以供应商账单为准", unknown: "费用待向供应商核对",
};

function message(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message
    : error instanceof Error ? error.message : "操作失败";
}

async function load() {
  const cwd = directory.value;
  const current = lifetime;
  if (!visible.value || !cwd || !current || current.signal.aborted || loading.value) return;
  loading.value = true;
  const activityRequest = loadActivityStatus(current);
  try {
    const { data } = await axios.get<{ code: number; message: string; data: { tasks: MediaTask[]; total: number; corruptCount: number; corruptTaskIds: string[] } }>("/api/ai/media/tasks/list", {
      params: {
        directory: cwd, offset: offset.value, limit: pageSize,
        mediaType: mediaTypeFilter.value || undefined, status: statusFilter.value || undefined, reviewState: reviewFilter.value || undefined,
      }, headers: taskHeaders(cwd), signal: current.signal, timeout: 15000,
    });
    if (current !== lifetime) return;
    if (data.code !== 200) throw new Error(data.message);
    corruptCount.value = data.data.corruptCount;
    corruptTaskIds.value = data.data.corruptTaskIds;
    if (offset.value > 0 && offset.value >= data.data.total) {
      offset.value = Math.max(0, Math.ceil(data.data.total / pageSize) - 1) * pageSize;
      return;
    }
    tasks.value = data.data.tasks;
    total.value = data.data.total;
    loadError.value = "";
  } catch (error) {
    if (!current.signal.aborted) loadError.value = message(error);
  } finally {
    await activityRequest;
    if (current === lifetime) loading.value = false;
  }
}

async function loadActivityStatus(current: AbortController) {
  if (!canManageCosts.value) return;
  try {
    const { data } = await axios.get<{ code: number; data: ActivityStatus }>("/api/activity/status", {
      headers: { "x-toonflow-workspace": "1" }, signal: current.signal, timeout: 15000,
    });
    if (current !== lifetime || current.signal.aborted || !canManageCosts.value) return;
    const status = data.data;
    if (data.code !== 200 || typeof status?.blocked !== "boolean" ||
      ![status.bytes, status.files, status.rejected].every(value => Number.isSafeInteger(value) && value >= 0) ||
      ![status.limits?.maxBytes, status.limits?.maxFiles, status.limits?.maxRecordBytes, status.limits?.minFreeBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
      ![status.reason, status.lastRejectedReason].every(value => value === null || typeof value === "string" && value.length <= 500)) {
      throw new Error("日志状态无效");
    }
    activityStatus.value = data.data;
    activityError.value = "";
  } catch {
    if (current !== lifetime || current.signal.aborted || !canManageCosts.value) return;
    activityStatus.value = undefined;
    activityError.value = "无法读取操作日志容量状态，当前留存状态未知；请刷新或联系管理员检查，不能据此确认日志正常留存。";
  }
}

function canCancel(task: MediaTask) {
  // 成员不能取消任务，服务端同样拒绝；这里只隐藏入口。
  return userRole.value === "admin" && ["queued", "running", "saving"].includes(task.status);
}

function openReview(task: MediaTask) {
  if (!directory.value || reviewSaving.value || reviewLoading.value || disposed) return;
  clearReview();
  reviewTarget = { directory: directory.value, id: task.id, revision: task.review?.revision ?? 0, projectId: projectId.value };
  reviewDecision.value = task.review?.decision ?? "approved";
  reviewComment.value = task.review?.comment ?? "";
  reviewError.value = "";
  reviewNotice.value = "";
  reviewVisible.value = true;
}

async function reloadReview() {
  const target = reviewTarget;
  if (!target || reviewSaving.value || reviewLoading.value || !reviewVisible.value || disposed) return;
  const request = new AbortController();
  reviewController?.abort(); reviewController = request;
  reviewLoading.value = true;
  try {
    await ElMessageBox.confirm("重新读取会用最新审核替换当前填写内容，未保存的草稿将丢失。是否继续？", "读取最新审核", { confirmButtonText: "读取并替换", cancelButtonText: "保留草稿", type: "warning" });
    if (request.signal.aborted || reviewTarget !== target) return;
    const { data } = await axios.get<{ code: number; message: string; data: MediaTask }>("/api/ai/media/tasks/get", {
      params: { directory: target.directory, id: target.id },
      headers: { "x-toonflow-workspace": "1", ...(target.projectId ? { "x-toonflow-project-id": target.projectId } : {}) }, signal: request.signal, timeout: 15000,
    });
    if (request.signal.aborted || reviewTarget !== target) return;
    if (data.code !== 200 || data.data?.id !== target.id) throw new Error(data.message || "未能读取对应任务的最新审核");
    reviewTarget = { ...target, revision: data.data.review?.revision ?? 0 };
    reviewDecision.value = data.data.review?.decision ?? "approved";
    reviewComment.value = data.data.review?.comment ?? "";
    reviewError.value = ""; reviewNeedsReload.value = false;
  } catch (error) {
    if (!request.signal.aborted && reviewTarget === target && error !== "cancel" && error !== "close") reviewError.value = message(error);
  } finally { if (reviewController === request) reviewLoading.value = false; }
}

async function saveReview() {
  const target = reviewTarget;
  if (!target || reviewSaving.value || reviewLoading.value || reviewNeedsReload.value || !reviewVisible.value || disposed) return;
  const request = new AbortController();
  reviewController?.abort(); reviewController = request;
  reviewSaving.value = true;
  reviewError.value = "";
  try {
    const { data } = await axios.put("/api/ai/media/tasks/review", {
      ...target, decision: reviewDecision.value, comment: reviewComment.value,
    }, { headers: { "x-toonflow-workspace": "1", ...(target.projectId ? { "x-toonflow-project-id": target.projectId } : {}) }, signal: request.signal, timeout: 15000 });
    if (request.signal.aborted || reviewTarget !== target) return;
    if (data.code !== 200) throw new Error(data.message);
    reviewNotice.value = "审核结果已保存。";
    reviewVisible.value = false;
    await load();
  } catch (error) {
    if (!request.signal.aborted && reviewTarget === target) {
      reviewNeedsReload.value = true;
      reviewError.value = `${message(error)}。请先读取最新审核核实结果，再决定是否提交；当前草稿暂时保留。`;
    }
  } finally { if (reviewController === request) reviewSaving.value = false; }
}

async function cancel(task: MediaTask) {
  const cwd = directory.value;
  const current = lifetime;
  if (!cwd || cancelling.value) return;
  cancelling.value = task.id;
  try {
    await ElMessageBox.confirm("停止本地处理可能无法取消供应商任务，也不代表退款。是否继续？", "取消生成任务", {
      confirmButtonText: "取消任务", cancelButtonText: "继续生成", type: "warning",
    });
    if (current !== lifetime || current?.signal.aborted) return;
    const { data } = await axios.post("/api/ai/media/tasks/cancel", { directory: cwd, id: task.id }, { headers: taskHeaders(cwd), signal: current?.signal, timeout: 15000 });
    if (current !== lifetime || current?.signal.aborted) return;
    if (data.code !== 200) throw new Error(data.message);
    await load();
  } catch (error) {
    if (current === lifetime && !current?.signal.aborted && error !== "cancel" && error !== "close") ElMessage.error(message(error));
  } finally { if (current === lifetime) cancelling.value = ""; }
}

async function resume(task: MediaTask) {
  const cwd = directory.value;
  const current = lifetime;
  const headers = cwd ? taskHeaders(cwd) : undefined;
  if (!cwd || resuming.value) return;
  resuming.value = task.id;
  try {
    const { data } = await axios.post("/api/ai/media/tasks/resume", { directory: cwd, id: task.id }, { headers, signal: current?.signal, timeout: 15000 });
    if (current !== lifetime || current?.signal.aborted) return;
    if (data.code !== 200) throw new Error(data.message);
    await load();
  } catch (error) {
    if (current === lifetime && !current?.signal.aborted) ElMessage.error(message(error));
  } finally { if (current === lifetime) resuming.value = ""; }
}

async function download(taskId: string, file: GeneratedMedia) {
  const cwd = directory.value;
  if (!cwd || disposed || !visible.value || downloading.value) return;
  const controller = new AbortController();
  downloadController = controller;
  downloading.value = `${taskId}:${file.path}`;
  const name = file.path.split("/").pop() || "media";
  downloadNotice.value = `正在准备下载 ${name}…`;
  downloadFailed.value = false;
  const files = useWorkspaceFiles(cwd, projectId.value);
  try {
    const saved = await saveFile(async () => {
      controller.signal.throwIfAborted();
      const content = await files.read(file.path, { signal: controller.signal, timeout: 30000 });
      controller.signal.throwIfAborted();
      return new Blob([content], { type: file.mimeType });
    }, name);
    if (controller.signal.aborted || downloadController !== controller) return;
    downloadNotice.value = saved ? `${name} 已提交文件保存，请检查浏览器下载列表或客户端保存位置。` : `已取消保存 ${name}。`;
  } catch (error) {
    if (!controller.signal.aborted && downloadController === controller) {
      downloadFailed.value = true;
      downloadNotice.value = `下载 ${name} 失败：${message(error)}。请重试。`;
    }
  } finally { if (downloadController === controller) { downloading.value = ""; downloadController = undefined; } }
}

async function exportCosts() {
  const cwd = directory.value, current = lifetime;
  if (!cwd || exportingCosts.value || !canManageCosts.value) return;
  exportingCosts.value = true;
  try {
    const { data } = await axios.get("/api/ai/media/tasks/costExport", { params: { directory: cwd }, headers: taskHeaders(cwd), signal: current?.signal, timeout: 30000 });
    if (current !== lifetime || current?.signal.aborted || !canManageCosts.value) return;
    if (data.code !== 200) throw new Error(data.message);
    await saveFile(new Blob([JSON.stringify(data.data, null, 2)], { type: "application/json" }), "projectCosts.json");
  } catch (cause) { if (current === lifetime && !current?.signal.aborted) ElMessage.error(message(cause)); }
  finally { exportingCosts.value = false; }
}

watch([visible, directory, projectId, canManageCosts], () => {
  clearTaskLogs(); logTaskId.value = "";
  closePreview();
  downloadController?.abort(); downloadController = undefined;
  downloading.value = ""; downloadNotice.value = ""; downloadFailed.value = false;
  offset.value = 0; tasks.value = []; total.value = 0; loadError.value = "";
  corruptCount.value = 0; corruptTaskIds.value = [];
  activityStatus.value = undefined; activityError.value = "";
  reviewVisible.value = false; clearReview(); reviewComment.value = ""; reviewError.value = ""; reviewNotice.value = "";
  historyVisible.value = false; historyTaskId.value = "";
  costVisible.value = false; costTaskId.value = "";
}, { flush: "sync" });
watch([mediaTypeFilter, statusFilter, reviewFilter], () => {
  offset.value = 0; tasks.value = []; total.value = 0; loadError.value = "";
  corruptCount.value = 0; corruptTaskIds.value = [];
}, { flush: "sync" });
watch([visible, directory, projectId, offset, mediaTypeFilter, statusFilter, reviewFilter, canManageCosts], (_value, _previous, onCleanup) => {
  lifetime = new AbortController();
  loading.value = false;
  const current = lifetime;
  if (visible.value) void load();
  const timer = visible.value ? setInterval(() => void load(), 5000) : undefined;
  onCleanup(() => { current.abort(); clearInterval(timer); cancelling.value = ""; resuming.value = ""; });
}, { immediate: true });
</script>

<style scoped lang="scss">
.mediaTasks {
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
  .el-button { min-height: 40px; }
  .taskDiagnostics {
    margin: 16px 0;
    padding: 12px 16px;
    background: var(--el-fill-color-light);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 12px;
    summary { cursor: pointer; font-weight: 600; min-height: 40px; align-content: center; }
    summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; border-radius: 4px; }
    .activityToolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .taskLogs {
      :deep(.el-date-editor) { max-width: 100%; box-sizing: border-box; }
      .el-button + .el-button { margin-left: 8px; }
    }
  }
  .taskLogs {
    margin-bottom: 16px;
    overflow-wrap: anywhere;
    .el-button { margin: 8px 0; }
    ol { max-height: 320px; overflow-y: auto; padding-left: 24px; }
    li { margin-bottom: 8px; line-height: 1.6; }
  }
  .taskFilters {
    display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
    .el-select { flex: 1 1 160px; }
  }
  .billingNote { color: var(--el-text-color-secondary); line-height: 1.6; margin-top: 0; }
  .taskToolbar, .taskPagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
  .taskToolbar { padding: 12px 0; .el-button { margin-left: 0; } }
  .taskError { color: var(--el-color-danger); background: var(--el-color-danger-light-9); border-radius: 8px; padding: 10px 12px; overflow-wrap: anywhere; }
  .taskItem {
    .taskDetails {
      summary { cursor: pointer; min-height: 40px; align-content: center; }
      summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
      .promptText, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    }
    border: 1px solid var(--el-border-color-lighter);
    border-left: 3px solid var(--el-border-color);
    border-radius: 12px;
    padding: 16px;
    margin: 12px 0;
    background: var(--el-bg-color);
    &[data-status="succeeded"] { border-left-color: var(--el-color-success); }
    &[data-status="running"], &[data-status="saving"] { border-left-color: var(--el-color-primary); }
    &[data-status="failed"], &[data-status="interrupted"], &[data-status="cancelled"] { border-left-color: var(--el-color-warning); }
    overflow-wrap: anywhere;
    p { margin: 8px 0; }
    .taskHeader { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; strong { margin-right: auto; } .el-button { margin-left: 0; } }
    .taskMeta { color: var(--el-text-color-secondary); font-size: 12px; }
    .taskReview { .reviewComment { white-space: pre-wrap; } }
    .taskFiles {
      display: grid; gap: 8px; margin: 12px 0;
      .taskFile {
        display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px;
        padding: 8px; border-radius: 8px; background: var(--el-fill-color-light);
        .fileName { min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
        .el-button { margin-left: 0; }
      }
    }
  }
  .taskPagination { margin-top: 16px; padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); }
}
.mediaPreview {
  video, img, audio { display: block; max-width: 100%; max-height: 70vh; margin: auto; }
  .previewError { color: var(--el-color-danger); overflow-wrap: anywhere; }
}
</style>
