<template>
  <el-drawer v-model="visible" title="生成任务" size="min(680px, 100vw)" appendToBody>
    <div class="mediaTasks">
      <p class="billingNote">费用由所选供应商结算。取消、断线或服务中断不代表上游已取消或退款；再次生成前请核对原任务。</p>
      <p class="billingNote">这里保留原始生成结果；局部重绘的蒙版合成等后续编辑结果请在画布中查看。</p>
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
      <div class="taskToolbar">
        <span>{{ hasFilters ? '符合条件' : '共' }} {{ total }} 个任务</span>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
      <p v-if="loadError" class="taskError" role="alert">{{ loadError }}</p>
      <p v-else-if="!loading && !tasks.length">{{ hasFilters ? '暂无符合筛选条件的任务' : '当前项目暂无生成任务' }}</p>
      <article v-for="task in tasks" :key="task.id" class="taskItem">
        <div class="taskHeader">
          <strong>{{ mediaLabels[task.mediaType] }} · {{ statusLabels[task.status] }}</strong>
          <el-button v-if="canCancel(task)" size="small" :loading="cancelling === task.id" @click="cancel(task)">取消任务</el-button>
        </div>
        <p>{{ task.providerId }} / {{ task.modelId }}</p>
        <p class="taskMeta">{{ new Date(task.createdAt).toLocaleString() }}</p>
        <p class="taskMeta">任务 ID：{{ task.id }}</p>
        <p>{{ billingLabels[task.billingState] }}</p>
        <p v-if="task.error" class="taskError">{{ task.error }}</p>
        <div v-if="task.files.length" class="taskFiles">
          <el-button v-for="file in task.files" :key="file.path" text type="primary"
            :loading="downloading === `${task.id}:${file.path}`" @click="download(task, file)">
            下载 {{ file.path.split('/').pop() }}
          </el-button>
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
  <el-dialog v-model="reviewVisible" title="审核生成结果" width="min(520px, 95vw)" appendToBody
    :closeOnClickModal="!reviewSaving" :closeOnPressEscape="!reviewSaving" :showClose="!reviewSaving">
    <p>审核针对本任务的全部原始生成结果，不包含画布后续编辑。保留最近 100 次审核记录。</p>
    <el-form labelPosition="top">
      <el-form-item label="审核结论">
        <el-radio-group v-model="reviewDecision" :disabled="reviewSaving" aria-label="审核结论">
          <el-radio value="approved">通过</el-radio>
          <el-radio value="changesRequested">需要修改</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="审核意见">
        <el-input v-model="reviewComment" type="textarea" :rows="4" :maxlength="2000" showWordLimit :disabled="reviewSaving" aria-label="审核意见" />
      </el-form-item>
    </el-form>
    <p v-if="reviewError" role="alert">{{ reviewError }}</p>
    <template #footer>
      <el-button :disabled="reviewSaving" @click="reviewVisible = false">取消</el-button>
      <el-button type="primary" :loading="reviewSaving" @click="saveReview">保存审核</el-button>
    </template>
  </el-dialog>
  <mediaReviewHistory v-model="historyVisible" :directory="directory" :taskId="historyTaskId" :projectId="workspaceStore.project?.serverProjectId" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import type { GeneratedMedia, MediaTask, MediaTaskFilters } from "@toonflow/tools-scaffold/runtime";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import saveFile from "@/lib/saveFile";
import mediaReviewHistory from "./mediaReviewHistory.vue";

const visible = defineModel<boolean>({ default: false });
const workspaceStore = useWorkspaceStore();
const directory = computed(() => workspaceStore.project?.directory);
const projectId = computed(() => workspaceStore.project?.serverProjectId);
const tasks = ref<MediaTask[]>([]);
const total = ref(0);
const offset = ref(0);
const mediaTypeFilter = ref<MediaTaskFilters["mediaType"] | "">("");
const statusFilter = ref<MediaTaskFilters["status"] | "">("");
const reviewFilter = ref<MediaTaskFilters["reviewState"] | "">("");
const hasFilters = computed(() => !!(mediaTypeFilter.value || statusFilter.value || reviewFilter.value));
const pageSize = 30;
const loading = ref(false);
const loadError = ref("");
const cancelling = ref("");
const downloading = ref("");
const reviewVisible = ref(false);
const reviewSaving = ref(false);
const reviewError = ref("");
const historyVisible = ref(false);
const historyTaskId = ref("");
const reviewDecision = ref<"approved" | "changesRequested">("approved");
const reviewComment = ref("");
let reviewTarget: { directory: string; id: string; revision: number; projectId?: string } | undefined;
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
  try {
    const { data } = await axios.get<{ code: number; message: string; data: { tasks: MediaTask[]; total: number } }>("/api/ai/media/tasks/list", {
      params: {
        directory: cwd, offset: offset.value, limit: pageSize,
        mediaType: mediaTypeFilter.value || undefined, status: statusFilter.value || undefined, reviewState: reviewFilter.value || undefined,
      }, headers: taskHeaders(cwd), signal: current.signal, timeout: 15000,
    });
    if (current !== lifetime) return;
    if (data.code !== 200) throw new Error(data.message);
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
    if (current === lifetime) loading.value = false;
  }
}

function canCancel(task: MediaTask) {
  return ["queued", "running", "saving"].includes(task.status);
}

function openReview(task: MediaTask) {
  if (!directory.value || reviewSaving.value) return;
  reviewTarget = { directory: directory.value, id: task.id, revision: task.review?.revision ?? 0, projectId: projectId.value };
  reviewDecision.value = task.review?.decision ?? "approved";
  reviewComment.value = task.review?.comment ?? "";
  reviewError.value = "";
  reviewVisible.value = true;
}

async function saveReview() {
  const target = reviewTarget;
  if (!target || reviewSaving.value) return;
  reviewSaving.value = true;
  try {
    const { data } = await axios.put("/api/ai/media/tasks/review", {
      ...target, decision: reviewDecision.value, comment: reviewComment.value,
    }, { headers: { "x-toonflow-workspace": "1", ...(target.projectId ? { "x-toonflow-project-id": target.projectId } : {}) }, timeout: 15000 });
    if (data.code !== 200) throw new Error(data.message);
    if (reviewTarget !== target) return;
    reviewVisible.value = false;
    await load();
  } catch (error) {
    if (reviewTarget === target) reviewError.value = message(error);
  } finally { reviewSaving.value = false; }
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
    const { data } = await axios.post("/api/ai/media/tasks/cancel", { directory: cwd, id: task.id }, { headers: taskHeaders(cwd), timeout: 15000 });
    if (data.code !== 200) throw new Error(data.message);
    await load();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(message(error));
  } finally { cancelling.value = ""; }
}

async function download(task: MediaTask, file: GeneratedMedia) {
  const cwd = directory.value;
  if (!cwd || downloading.value) return;
  downloading.value = `${task.id}:${file.path}`;
  const files = useWorkspaceFiles(cwd, projectId.value);
  try {
    await saveFile(async () => new Blob([await files.read(file.path)], { type: file.mimeType }), file.path.split("/").pop() || "media");
  } catch (error) { ElMessage.error(message(error)); }
  finally { downloading.value = ""; }
}

watch([visible, directory, projectId], () => {
  offset.value = 0; tasks.value = []; total.value = 0; loadError.value = "";
  reviewVisible.value = false; reviewTarget = undefined; reviewComment.value = ""; reviewError.value = "";
  historyVisible.value = false; historyTaskId.value = "";
});
watch([mediaTypeFilter, statusFilter, reviewFilter], () => {
  offset.value = 0; tasks.value = []; total.value = 0; loadError.value = "";
}, { flush: "sync" });
watch([visible, directory, projectId, offset, mediaTypeFilter, statusFilter, reviewFilter], (_value, _previous, onCleanup) => {
  lifetime = new AbortController();
  loading.value = false;
  const current = lifetime;
  if (visible.value) void load();
  const timer = visible.value ? setInterval(() => void load(), 5000) : undefined;
  onCleanup(() => { current.abort(); clearInterval(timer); });
}, { immediate: true });
</script>

<style scoped lang="scss">
.mediaTasks {
  .taskFilters {
    display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
    .el-select { flex: 1 1 160px; }
  }
  .billingNote { color: var(--el-text-color-secondary); line-height: 1.6; margin-top: 0; }
  .taskToolbar, .taskPagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .taskError { color: var(--el-color-danger); overflow-wrap: anywhere; }
  .taskItem {
    border-bottom: 1px solid var(--el-border-color-lighter);
    padding: 16px 0;
    overflow-wrap: anywhere;
    p { margin: 8px 0; }
    .taskHeader { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .taskMeta { color: var(--el-text-color-secondary); font-size: 12px; }
    .taskReview { .reviewComment { white-space: pre-wrap; } }
    .taskFiles {
      display: flex; flex-direction: column; align-items: flex-start;
      .el-button { margin-left: 0; max-width: 100%; height: auto; white-space: normal; text-align: left; }
    }
  }
  .taskPagination { margin-top: 16px; }
}
</style>
