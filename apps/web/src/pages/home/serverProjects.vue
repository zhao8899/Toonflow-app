<template>
  <el-button :disabled="disabled" @click="visible = true">服务器项目</el-button>
  <el-dialog v-model="visible" title="服务器项目" width="min(720px, 95vw)" appendToBody :closeOnClickModal="!saving" :closeOnPressEscape="!saving" :showClose="!saving">
    <div class="serverProjects">
      <p>登记已有服务器子目录，所有可信管理员共享可见。登记不复制文件，也不授予普通账号访问权限。</p>
      <el-form labelPosition="top" @submit.prevent="register">
        <el-form-item label="项目名称">
          <el-input v-model="name" :maxlength="100" :disabled="saving" aria-label="项目名称" />
        </el-form-item>
        <el-form-item label="工作目录">
          <workspacePicker v-model="directory" :disabled="saving" />
          <span class="directoryPath">{{ directory }}</span>
        </el-form-item>
        <el-button type="primary" nativeType="submit" :loading="saving" :disabled="!directory || !name.trim()">登记项目</el-button>
        <el-button :loading="loading" :disabled="saving" @click="refresh += 1">刷新列表</el-button>
      </el-form>
      <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
      <p v-if="!loading && !projects.length && !errorMessage">暂无已登记项目</p>
      <article v-for="project in projects" :key="project.id" class="projectItem">
        <strong>{{ project.name }}</strong>
        <p>{{ project.directory }}</p>
        <p>项目 ID：{{ project.id }}</p>
        <el-button :disabled="saving || disabled" @click="open(project)">打开项目</el-button>
      </article>
      <div class="projectPagination">
        <el-button :disabled="offset === 0 || loading || saving" @click="offset -= 30">上一页</el-button>
        <span>共 {{ total }} 个项目</span>
        <el-button :disabled="offset + 30 >= total || loading || saving" @click="offset += 30">下一页</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";
import workspacePicker from "./workspacePicker.vue";

type ServerProject = { id: string; name: string; directory: string; createdAt: string; createdBy: string };
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();
const visible = ref(false);
const name = ref("");
const directory = ref("");
const saving = ref(false);
const loading = ref(false);
const errorMessage = ref("");
const projects = ref<ServerProject[]>([]);
const total = ref(0);
const offset = ref(0);
const refresh = ref(0);
const headers = { "x-toonflow-workspace": "1" };

function message(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message
    : error instanceof Error ? error.message : "操作失败";
}

function open(project: ServerProject) {
  visible.value = false;
  emit("open", project.id);
}

async function register() {
  if (saving.value) return;
  saving.value = true;
  errorMessage.value = "";
  try {
    const { data } = await axios.post("/api/projects/register", { name: name.value.trim(), directory: directory.value }, { headers, timeout: 15000 });
    if (data.code !== 200) throw new Error(data.message);
    name.value = ""; directory.value = ""; offset.value = 0; refresh.value++;
  } catch (error) { errorMessage.value = message(error); }
  finally { saving.value = false; }
}

watch(visible, () => { offset.value = 0; errorMessage.value = ""; });
watch([visible, offset, refresh], async (_value, _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  projects.value = []; total.value = 0; loading.value = false;
  if (!visible.value) return;
  errorMessage.value = "";
  loading.value = true;
  try {
    const { data } = await axios.get<{ code: number; message: string; data: { projects: ServerProject[]; total: number } }>("/api/projects/list", {
      params: { offset: offset.value, limit: 30 }, headers, signal: controller.signal, timeout: 15000,
    });
    if (controller.signal.aborted) return;
    if (data.code !== 200) throw new Error(data.message);
    projects.value = data.data.projects; total.value = data.data.total;
  } catch (error) { if (!controller.signal.aborted) errorMessage.value = message(error); }
  finally { if (!controller.signal.aborted) loading.value = false; }
});
</script>

<style scoped lang="scss">
.serverProjects {
  overflow-wrap: anywhere;
  .directoryPath { margin-left: 12px; }
  .projectItem { padding: 16px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .projectPagination { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; }
}
</style>
