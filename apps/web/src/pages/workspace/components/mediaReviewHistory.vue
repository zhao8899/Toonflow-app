<template>
  <el-dialog v-model="visible" title="审核历史" width="min(600px, 95vw)" appendToBody>
    <div class="reviewHistory">
      <p>按最新到最早展示最近 100 次审核。旧版已覆盖的结论无法补回；记录不代表素材文件版本。</p>
      <el-button :loading="loading" @click="refresh += 1">刷新</el-button>
      <p v-if="errorMessage" class="historyError" role="alert">{{ errorMessage }}</p>
      <p v-else-if="!loading && !entries.length">暂无审核记录</p>
      <article v-for="entry in entries" :key="entry.revision" class="historyItem">
        <strong>第 {{ entry.revision }} 次 · {{ entry.decision === 'approved' ? '审核通过' : '需要修改' }}</strong>
        <p>{{ entry.reviewer?.username ?? '本地操作者（未认证）' }} · {{ new Date(entry.reviewedAt).toLocaleString() }}</p>
        <p class="historyComment">{{ entry.comment }}</p>
      </article>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";
import type { MediaTask } from "@toonflow/tools-scaffold/runtime";

const visible = defineModel<boolean>({ default: false });
const props = defineProps<{ directory?: string; taskId: string; projectId?: string }>();
const entries = ref<NonNullable<MediaTask["review"]>[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const refresh = ref(0);

watch([visible, () => props.directory, () => props.taskId, () => props.projectId, refresh], async (_value, _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  entries.value = [];
  errorMessage.value = "";
  loading.value = false;
  const directory = props.directory;
  const id = props.taskId;
  if (!visible.value || !directory || !id) return;
  loading.value = true;
  try {
    const { data } = await axios.get<{ code: number; message: string; data: NonNullable<MediaTask["review"]>[] }>("/api/ai/media/tasks/reviewHistory", {
      params: { directory, id }, headers: {
        "x-toonflow-workspace": "1", ...(props.projectId ? { "x-toonflow-project-id": props.projectId } : {}),
      }, signal: controller.signal, timeout: 15000,
    });
    if (controller.signal.aborted) return;
    if (data.code !== 200) throw new Error(data.message);
    entries.value = data.data;
  } catch (error) {
    if (controller.signal.aborted) return;
    errorMessage.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message
      : error instanceof Error ? error.message : "读取审核历史失败";
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}, { immediate: true });
</script>

<style scoped lang="scss">
.reviewHistory {
  overflow-wrap: anywhere;
  .historyError { color: var(--el-color-danger); }
  .historyItem {
    padding: 16px 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
    .historyComment { white-space: pre-wrap; }
  }
}
</style>
