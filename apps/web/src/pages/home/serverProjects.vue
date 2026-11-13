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
        <p>成员：{{ project.members.length ? project.members.map(memberName).join("、") : "暂无" }}</p>
        <el-button :disabled="saving || disabled" @click="open(project)">打开项目</el-button>
        <el-button :disabled="saving" @click="editMembers(project)">编辑成员</el-button>
        <el-button :disabled="saving" @click="editModels(project)">模型授权</el-button>
      </article>
      <div class="projectPagination">
        <el-button :disabled="offset === 0 || loading || saving" @click="offset -= 30">上一页</el-button>
        <span>共 {{ total }} 个项目</span>
        <el-button :disabled="offset + 30 >= total || loading || saving" @click="offset += 30">下一页</el-button>
      </div>
    </div>
  </el-dialog>
  <el-dialog v-model="membersVisible" title="编辑项目成员" width="min(480px, 92vw)" appendToBody :closeOnClickModal="!saving" :closeOnPressEscape="!saving" :showClose="!saving">
    <p>成员可查看本项目的生成任务、下载结果并提交审片意见。保存后完整替换原名单；管理员无需加入即可访问全部项目。</p>
    <el-select v-model="selectedMembers" multiple filterable :disabled="saving" placeholder="选择成员账号" aria-label="项目成员" style="width: 100%">
      <el-option v-for="account in memberAccounts" :key="account.id" :label="account.status === 'active' ? account.username : `${account.username}（已停用）`" :value="account.id" />
    </el-select>
    <p v-if="membersError" role="alert">{{ membersError }}</p>
    <template #footer>
      <el-button :disabled="saving" @click="membersVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveMembers">保存</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="modelsVisible" title="项目模型授权" width="min(520px, 92vw)" appendToBody :closeOnClickModal="!saving" :closeOnPressEscape="!saving" :showClose="!saving">
    <p>设置本项目成员可见的媒体模型。空名单表示未授权；保存模型白名单不会自动开启成员生成。</p>
    <el-select v-model="selectedModels" multiple filterable :disabled="saving || modelsLoading" :loading="modelsLoading" aria-label="授权媒体模型" style="width: 100%">
      <el-option v-for="model in availableModels" :key="modelKey(model)" :value="modelKey(model)" :label="`${model.providerLabel} / ${model.label} (${model.modelId})`" />
    </el-select>
    <section aria-label="成员生成授权">
      <p>成员生成：{{ modelsTarget?.memberGenerationEnabled && (modelsTarget.memberDailyGenerationLimit ?? 0) > 0 ? '已开启' : '已关闭或需设置每日额度' }}；已保存每日上限：{{ modelsTarget?.memberDailyGenerationLimit ?? 0 }} 次</p>
      <p>启用后，项目成员可使用实例已配置的供应商账户生成视频并产生费用。目前仅支持 4 / 5 秒、720p / 1080p 视频。</p>
      <p>请先保存模型白名单。停用只阻止新提交，不保证取消在途任务或退款。</p>
      <p>按北京时间自然日计算，项目全部成员共享。已接受的任务失败或取消也计次。0 禁止新生成；这是次数上限，不是金额上限。</p>
      <el-input-number v-model="generationDailyLimit" :min="0" :max="1000" :precision="0" :disabled="saving" aria-label="每日成员生成次数上限" />
      <el-checkbox v-model="generationEnabled" :disabled="saving">启用成员生成</el-checkbox>
      <el-checkbox v-if="generationEnabled && (!modelsTarget?.memberGenerationEnabled || !(modelsTarget?.memberDailyGenerationLimit ?? 0))" v-model="generationConfirmed" :disabled="saving">我确认授权项目成员使用实例供应商账户生成视频并承担产生的费用</el-checkbox>
      <el-button :loading="saving" :disabled="saving" @click="saveGeneration">保存生成授权及每日上限</el-button>
      <el-button @click="openGenerationHistory">查看变更记录</el-button>
    </section>
    <p v-if="modelsError" role="alert">{{ modelsError }}</p>
    <template #footer>
      <el-button :disabled="saving" @click="modelsVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="modelsLoading || !modelsLoaded" @click="saveModels">保存</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="historyVisible" title="成员生成策略变更记录" width="min(600px, 92vw)" appendToBody>
    <p>{{ historyTarget?.name }}（{{ historyTarget?.id }}）</p>
    <p>最近最多 100 条，按时间倒序显示。</p>
    <p v-if="historyLoading" role="status">正在加载变更记录…</p>
    <p v-else-if="historyError" role="alert">{{ historyError }}</p>
    <p v-else-if="!generationHistory.length">暂无变更记录</p>
    <article v-for="entry in generationHistory" :key="entry.id" class="historyEntry">
      <p>{{ new Date(entry.createdAt).toLocaleString('zh-CN') }} · {{ entry.actor.username }}（{{ entry.actor.id }}）</p>
      <p>成员生成：{{ entry.previous.enabled ? '开启' : '关闭' }} → {{ entry.current.enabled ? '开启' : '关闭' }}</p>
      <p>每日额度：{{ entry.previous.dailyLimit }} 次 → {{ entry.current.dailyLimit }} 次</p>
    </article>
    <template #footer><el-button :disabled="historyLoading" @click="historyRefresh++">刷新</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";
import workspacePicker from "./workspacePicker.vue";

type ModelGrant = { providerId: string; modelId: string };
type ModelChoice = ModelGrant & { providerLabel: string; label: string };
type ServerProject = { id: string; name: string; directory: string; createdAt: string; createdBy: string; members: string[]; mediaModels: ModelGrant[]; memberGenerationEnabled?: boolean; memberDailyGenerationLimit?: number };
type Account = { id: string; username: string; role: "admin" | "user"; status: string };
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
const modelsVisible = ref(false);
const modelsLoading = ref(false);
const modelsLoaded = ref(false);
const modelsError = ref("");
const selectedModels = ref<string[]>([]);
const availableModels = ref<ModelChoice[]>([]);
const modelsTarget = ref<ServerProject>();
const generationConfirmed = ref(false);
const generationEnabled = ref(false);
const generationDailyLimit = ref<number | undefined>(0);
type GenerationHistoryEntry = { id: string; createdAt: string; actor: { id: string; username: string }; previous: { enabled: boolean; dailyLimit: number }; current: { enabled: boolean; dailyLimit: number } };
const historyVisible = ref(false);
const historyTarget = ref<{ id: string; name: string }>();
const historyLoading = ref(false);
const historyError = ref("");
const historyRefresh = ref(0);
const generationHistory = ref<GenerationHistoryEntry[]>([]);

function openGenerationHistory() {
  const target = modelsTarget.value;
  if (!target) return;
  historyTarget.value = { id: target.id, name: target.name };
  historyVisible.value = true;
}

watch([modelsVisible, modelsTarget], () => { historyVisible.value = false; }, { flush: "sync" });
watch([historyVisible, historyTarget, historyRefresh], async (_value, _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  generationHistory.value = []; historyError.value = ""; historyLoading.value = false;
  const target = historyTarget.value;
  if (!historyVisible.value || !target) return;
  historyLoading.value = true;
  try {
    const { data } = await axios.get<{ code: number; message: string; data: GenerationHistoryEntry[] }>("/api/projects/generationHistory", {
      params: { id: target.id }, headers, signal: controller.signal, timeout: 15000,
    });
    if (controller.signal.aborted) return;
    if (data.code !== 200) throw new Error(data.message);
    generationHistory.value = data.data;
  } catch (error) { if (!controller.signal.aborted) historyError.value = `变更记录加载失败：${message(error)}`; }
  finally { if (!controller.signal.aborted) historyLoading.value = false; }
}, { flush: "sync" });
const modelKey = (model: ModelGrant) => JSON.stringify([model.providerId, model.modelId]);

function editModels(project: ServerProject) {
  if (saving.value) return;
  generationConfirmed.value = false;
  generationDailyLimit.value = project.memberDailyGenerationLimit ?? 0;
  generationEnabled.value = !!project.memberGenerationEnabled && generationDailyLimit.value > 0;
  modelsTarget.value = project;
  modelsVisible.value = true;
}

watch([modelsVisible, modelsTarget], async (_value, _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  modelsLoaded.value = false; modelsLoading.value = false; modelsError.value = "";
  availableModels.value = []; selectedModels.value = [];
  if (!modelsVisible.value || !modelsTarget.value) return;
  const grants = modelsTarget.value.mediaModels ?? [];
  modelsLoading.value = true;
  try {
    const { data } = await axios.get<{ code: number; message: string; data: ModelChoice[] }>("/api/ai/media/models", { headers, signal: controller.signal, timeout: 15000 });
    if (controller.signal.aborted) return;
    if (data.code !== 200) throw new Error(data.message);
    availableModels.value = data.data;
    selectedModels.value = grants.map(modelKey);
    // 保留已移除模型的选项，便于管理员识别并显式撤销，避免静默丢失授权。
    for (const grant of grants) {
      if (!data.data.some(model => modelKey(model) === modelKey(grant))) {
        availableModels.value.push({ ...grant, providerLabel: grant.providerId, label: "已移除，请取消授权" });
      }
    }
    modelsLoaded.value = true;
  } catch (error) { if (!controller.signal.aborted) modelsError.value = message(error); }
  finally { if (!controller.signal.aborted) modelsLoading.value = false; }
});

async function saveModels() {
  if (saving.value || !modelsLoaded.value || !modelsTarget.value) return;
  saving.value = true; modelsError.value = "";
  const id = modelsTarget.value.id;
  const models = availableModels.value.filter(model => selectedModels.value.includes(modelKey(model)))
    .map(({ providerId, modelId }) => ({ providerId, modelId }));
  try {
    const { data } = await axios.put("/api/projects/mediaModels", { id, models }, { headers, timeout: 15000 });
    if (data.code !== 200) throw new Error(data.message);
    modelsVisible.value = false; refresh.value++;
  } catch (error) { modelsError.value = message(error); }
  finally { saving.value = false; }
}

async function saveGeneration() {
  const target = modelsTarget.value;
  if (saving.value || !target) return;
  const enabled = generationEnabled.value;
  const dailyLimit = generationDailyLimit.value;
  if (dailyLimit === undefined || !Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000 || (enabled && dailyLimit === 0)) {
    modelsError.value = "每日上限须为 0–1000 的整数；启用成员生成时必须大于 0。";
    return;
  }
  if (enabled && (!target.mediaModels.length || ((!target.memberGenerationEnabled || !(target.memberDailyGenerationLimit ?? 0)) && !generationConfirmed.value))) {
    modelsError.value = "请先保存模型白名单，并确认使用实例供应商账户产生费用。";
    return;
  }
  saving.value = true;
  modelsError.value = "";
  try {
    const { data } = await axios.put("/api/projects/generation", { id: target.id, enabled, billingOwner: "instance", dailyLimit }, { headers, timeout: 15000 });
    if (data.code !== 200) throw new Error(data.message);
    target.memberGenerationEnabled = enabled;
    target.memberDailyGenerationLimit = dailyLimit;
    if (historyVisible.value && historyTarget.value?.id === target.id) historyRefresh.value++;
    generationConfirmed.value = false;
    refresh.value++;
  } catch (error) { modelsError.value = message(error); }
  finally { saving.value = false; }
}

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

const membersVisible = ref(false);
const membersError = ref("");
const selectedMembers = ref<string[]>([]);
const memberAccounts = ref<Account[]>([]);
let membersTarget = "";

function memberName(id: string) {
  return memberAccounts.value.find(account => account.id === id)?.username ?? id;
}

async function loadAccounts() {
  // ACT: 账号列表单页最多 100 条，满足当前小团队规模；超过后需改为远程搜索。
  const response = await fetch("/api/users/list?offset=0&limit=100", { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || "账号列表读取失败");
  memberAccounts.value = (body.data.users as Account[]).filter(account => account.role === "user");
}

async function editMembers(project: ServerProject) {
  membersTarget = project.id;
  selectedMembers.value = [...project.members];
  membersError.value = "";
  membersVisible.value = true;
  try { await loadAccounts(); }
  catch (error) { membersError.value = message(error); }
}

async function saveMembers() {
  if (saving.value) return;
  saving.value = true;
  membersError.value = "";
  try {
    const { data } = await axios.put("/api/projects/members", { id: membersTarget, members: selectedMembers.value }, { headers, timeout: 15000 });
    if (data.code !== 200) throw new Error(data.message);
    membersVisible.value = false;
    refresh.value++;
  } catch (error) { membersError.value = message(error); }
  finally { saving.value = false; }
}

watch(visible, () => {
  offset.value = 0; errorMessage.value = "";
  if (visible.value) void loadAccounts().catch(() => {});
});
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
    const target = modelsTarget.value;
    const updated = target && projects.value.find(project => project.id === target.id);
    if (target && updated) Object.assign(target, updated);
  } catch (error) { if (!controller.signal.aborted) errorMessage.value = message(error); }
  finally { if (!controller.signal.aborted) loading.value = false; }
});
</script>

<style scoped lang="scss">
.historyEntry { padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); overflow-wrap: anywhere; }
.serverProjects {
  overflow-wrap: anywhere;
  .directoryPath { margin-left: 12px; }
  .projectItem { padding: 16px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .projectPagination { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; }
}
</style>
