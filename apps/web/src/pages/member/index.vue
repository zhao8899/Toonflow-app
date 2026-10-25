<template>
  <main class="memberPortal">
    <header class="portalHeader">
      <h1>我的项目</h1>
      <div class="headerActions">
        <sessionMenu />
      </div>
    </header>
    <p class="portalNote">成员账号可查看已加入项目的生成任务、下载结果并提交审片意见；发起生成与全局设置由管理员负责。</p>
    <div class="portalToolbar">
      <span>共 {{ total }} 个项目</span>
      <el-button :loading="loading" @click="refresh += 1">刷新</el-button>
    </div>
    <p v-if="errorMessage" class="portalError" role="alert">{{ errorMessage }}</p>
    <p v-else-if="!loading && !projects.length">尚未加入任何项目，请联系管理员添加。</p>
    <article v-for="item in projects" :key="item.id" class="projectItem">
      <strong>{{ item.name }}</strong>
      <el-button type="primary" :loading="opening === item.id" :disabled="!!opening" @click="open(item.id)">查看生成任务</el-button>
    </article>
    <div class="portalPagination">
      <el-button :disabled="offset === 0 || loading" @click="offset -= pageSize">上一页</el-button>
      <span>{{ Math.floor(offset / pageSize) + 1 }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
      <el-button :disabled="offset + pageSize >= total || loading" @click="offset += pageSize">下一页</el-button>
    </div>
    <mediaTasks v-model="tasksVisible" />
  </main>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { useWorkspaceStore } from "@/stores/workspace";
import sessionMenu from "@/components/sessionMenu.vue";
import mediaTasks from "@/pages/workspace/components/mediaTasks.vue";

type MemberProject = { id: string; name: string };
const workspaceStore = useWorkspaceStore();
const projects = ref<MemberProject[]>([]);
const total = ref(0);
const offset = ref(0);
const refresh = ref(0);
const pageSize = 30;
const loading = ref(false);
const errorMessage = ref("");
const opening = ref("");
const tasksVisible = ref(false);

function message(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message
    : error instanceof Error ? error.message : "操作失败";
}

async function open(id: string) {
  opening.value = id;
  try {
    await workspaceStore.openServerProject(id);
    tasksVisible.value = true;
  } catch (error) { ElMessage.error(message(error)); }
  finally { opening.value = ""; }
}

watch([offset, refresh], async (_value, _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  loading.value = true;
  errorMessage.value = "";
  try {
    const { data } = await axios.get<{ code: number; message: string; data: { projects: MemberProject[]; total: number } }>("/api/projects/list", {
      params: { offset: offset.value, limit: pageSize }, headers: { "x-toonflow-workspace": "1" }, signal: controller.signal, timeout: 15000,
    });
    if (data.code !== 200) throw new Error(data.message);
    projects.value = data.data.projects;
    total.value = data.data.total;
  } catch (error) { if (!controller.signal.aborted) errorMessage.value = message(error); }
  finally { if (!controller.signal.aborted) loading.value = false; }
}, { immediate: true });
</script>

<style scoped lang="scss">
.memberPortal {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 16px;
  overflow-wrap: anywhere;

  .portalHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    h1 { margin: 0; font-size: 22px; }
  }
  .portalNote { color: var(--el-text-color-secondary); line-height: 1.6; }
  .portalToolbar, .portalPagination, .projectItem { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .projectItem { padding: 14px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .portalPagination { margin-top: 16px; }
  .portalError { color: var(--el-color-danger); }
}
</style>
