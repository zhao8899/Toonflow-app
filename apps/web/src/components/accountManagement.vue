<template>
  <el-drawer v-model="visible" title="账号管理" size="min(640px, 100vw)" appendToBody :closeOnClickModal="!saving" :closeOnPressEscape="!saving" :showClose="!saving" @closed="clearForm">
    <div class="accountManagement">
      <form class="accountForm" @submit.prevent="createAccount">
        <h3>新增管理员</h3>
        <p>管理员可以访问本实例的全部设置、插件、Agent 和授权工作区。请仅为可信人员创建账号。</p>
        <label :for="`${formId}Username`">用户名（3～20 个字符）</label>
        <el-input :id="`${formId}Username`" v-model="username" autocomplete="off" :maxlength="20" :disabled="saving" />
        <label :for="`${formId}Password`">初始密码（至少 12 个字符）</label>
        <el-input :id="`${formId}Password`" v-model="password" type="password" autocomplete="new-password" :maxlength="1024" :disabled="saving" showPassword />
        <el-button type="primary" nativeType="submit" :loading="saving">创建管理员</el-button>
      </form>
      <p v-if="actionError" class="accountError" role="alert">{{ actionError }}</p>
      <div class="accountToolbar">
        <span>共 {{ total }} 个账号</span>
        <el-button :disabled="saving" @click="auditVisible = true">操作记录</el-button>
        <el-button :loading="loading" :disabled="saving" @click="load">刷新</el-button>
      </div>
      <p v-if="loadError" class="accountError" role="alert">{{ loadError }}</p>
      <article v-for="account in accounts" :key="account.id" class="accountItem">
        <div>
          <strong>{{ account.username }}{{ account.id === currentUserId ? '（当前账号）' : '' }}</strong>
          <p>{{ account.role === 'admin' ? '管理员' : '普通用户' }} · {{ statusLabels[account.status] }}</p>
          <p>最近登录：{{ account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : '尚未登录' }}</p>
        </div>
        <el-button :type="account.status === 'active' ? 'danger' : 'primary'" :disabled="saving || loading" @click="setStatus(account)">{{ account.status === 'active' ? '停用' : '恢复' }}</el-button>
      </article>
      <p class="accountNote">普通用户暂不能进入管理员工作台；停用会撤销旧会话，恢复后需要重新登录。已开始的后台任务不会自动取消。</p>
      <div class="accountPagination">
        <el-button :disabled="!offset || saving || loading" @click="offset -= pageSize">上一页</el-button>
        <span>{{ Math.floor(offset / pageSize) + 1 }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
        <el-button :disabled="offset + pageSize >= total || saving || loading" @click="offset += pageSize">下一页</el-button>
      </div>
    </div>
    <accountAudit v-model="auditVisible" />
  </el-drawer>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import accountAudit from "@/components/accountAudit.vue";

interface Account {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled" | "pending";
  lastLoginAt?: string;
}

const visible = defineModel<boolean>({ default: false });
const auditVisible = ref(false);
const formId = useId();
const username = ref("");
const password = ref("");
const saving = ref(false);
const loading = ref(false);
const loadError = ref("");
const actionError = ref("");
const accounts = ref<Account[]>([]);
const currentUserId = ref("");
const offset = ref(0);
const total = ref(0);
const pageSize = 30;
const statusLabels = { active: "可用", disabled: "已停用", pending: "待审核" };
let request: AbortController | undefined;

function clearForm() {
  username.value = "";
  password.value = "";
  actionError.value = "";
}

async function load() {
  request?.abort();
  if (!visible.value) return;
  const current = new AbortController();
  request = current;
  loading.value = true;
  loadError.value = "";
  try {
    const response = await fetch(`/api/users/list?offset=${offset.value}&limit=${pageSize}`, { cache: "no-store", signal: current.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "账号列表读取失败");
    if (current.signal.aborted) return;
    accounts.value = body.data.users;
    total.value = body.data.total;
    currentUserId.value = body.data.currentUserId;
  } catch (cause) {
    if (!current.signal.aborted) loadError.value = cause instanceof Error ? cause.message : "账号列表读取失败";
  } finally {
    if (request === current) loading.value = false;
  }
}

async function createAccount() {
  if (saving.value) return;
  actionError.value = "";
  if (username.value.length < 3 || username.value !== username.value.trim() || password.value.length < 12) {
    actionError.value = "用户名需为 3～20 个字符且首尾无空白，初始密码至少 12 个字符";
    return;
  }
  saving.value = true;
  try {
    const response = await fetch("/api/users/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "创建失败");
    clearForm();
    ElMessage.success("管理员账号已创建");
    if (offset.value) offset.value = 0;
    else await load();
  } catch (cause) {
    actionError.value = cause instanceof TypeError ? "未能确认创建结果，请先刷新列表核对，不要重复创建" : cause instanceof Error ? cause.message : "创建失败";
  } finally { saving.value = false; }
}

async function setStatus(account: Account) {
  if (saving.value) return;
  const status = account.status === "active" ? "disabled" : "active";
  saving.value = true;
  try {
    await ElMessageBox.confirm(status === "disabled"
      ? `停用 ${account.username} 将使其旧会话失效${account.id === currentUserId.value ? '，并退出当前登录' : ''}。已开始的后台任务会继续运行。`
      : `恢复 ${account.username} 后，该账号可重新登录；旧会话不会恢复。`, status === "disabled" ? "停用账号" : "恢复账号", {
      confirmButtonText: "确认", cancelButtonText: "取消", type: "warning",
    });
    actionError.value = "";
    const response = await fetch("/api/users/setStatus", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: account.id, status }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "账号状态保存失败");
    if (account.id === currentUserId.value && status === "disabled") return window.location.reload();
    ElMessage.success(status === "disabled" ? "账号已停用" : "账号已恢复");
    await load();
  } catch (cause) {
    if (cause !== "cancel" && cause !== "close") actionError.value = cause instanceof TypeError ? "未能确认保存结果，请刷新列表核对" : cause instanceof Error ? cause.message : "账号状态保存失败";
  } finally { saving.value = false; }
}

watch([visible, offset], () => {
  if (visible.value) void load();
  else request?.abort();
});
onBeforeUnmount(() => request?.abort());
</script>

<style scoped lang="scss">
.accountManagement {
  display: flex;
  flex-direction: column;
  gap: 18px;

  .accountForm {
    display: flex;
    flex-direction: column;
    gap: 10px;
    h3, p { margin: 0; }
    p { line-height: 1.6; color: var(--el-text-color-secondary); }
  }
  .accountToolbar, .accountPagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .accountItem {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 0;
    border-bottom: 1px solid var(--el-border-color);
    p { margin: 6px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }
  }
  .accountNote { color: var(--el-text-color-secondary); line-height: 1.6; margin: 0; }
  .accountError { color: var(--el-color-danger); margin: 0; }
}
</style>
