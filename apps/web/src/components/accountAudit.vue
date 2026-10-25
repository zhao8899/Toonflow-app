<template>
  <el-drawer v-model="visible" title="账号操作记录" size="min(640px, 100vw)" appendToBody>
    <div class="accountAudit">
      <p class="auditNote">显示功能启用后成功保存的操作，最多保留最近 1000 条。历史操作不补录；不包含密码或令牌。</p>
      <div class="auditToolbar">
        <span>当前保留 {{ total }} 条记录</span>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
      <p v-if="failure" class="auditError" role="alert">{{ failure }}</p>
      <p v-else-if="!loading && !events.length">暂无操作记录</p>
      <article v-for="event in events" :key="event.id" class="auditItem">
        <strong>{{ actionLabels[event.action] }}</strong>
        <p>操作者：{{ event.actor?.username ?? '系统初始化或维护' }}</p>
        <p>目标账号：{{ event.target.username }}</p>
        <p v-if="event.action === 'statusChanged'">{{ event.previousStatus ? statusLabels[event.previousStatus] : '未知' }} → {{ event.status ? statusLabels[event.status] : '未知' }}</p>
        <time :datetime="event.createdAt">{{ new Date(event.createdAt).toLocaleString() }}</time>
      </article>
      <div class="auditPagination">
        <el-button :disabled="!offset || loading" @click="offset -= pageSize">上一页</el-button>
        <span>{{ Math.floor(offset / pageSize) + 1 }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
        <el-button :disabled="offset + pageSize >= total || loading" @click="offset += pageSize">下一页</el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

interface AuditEvent {
  id: string;
  createdAt: string;
  action: "administratorCreated" | "memberCreated" | "statusChanged" | "passwordChanged" | "sessionsRevoked";
  actor: { id: string; username: string } | null;
  target: { id: string; username: string };
  previousStatus?: "active" | "disabled" | "pending";
  status?: "active" | "disabled" | "pending";
}

const visible = defineModel<boolean>({ default: false });
const events = ref<AuditEvent[]>([]);
const total = ref(0);
const offset = ref(0);
const pageSize = 30;
const loading = ref(false);
const failure = ref("");
const actionLabels = { administratorCreated: "创建管理员", memberCreated: "创建成员", statusChanged: "变更账号状态", passwordChanged: "修改密码", sessionsRevoked: "撤销全部会话" };
const statusLabels = { active: "可用", disabled: "已停用", pending: "待审核" };
let request: AbortController | undefined;

async function load() {
  request?.abort();
  if (!visible.value) return;
  const current = new AbortController();
  request = current;
  loading.value = true;
  failure.value = "";
  try {
    const response = await fetch(`/api/users/audit?offset=${offset.value}&limit=${pageSize}`, { cache: "no-store", signal: current.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "无法读取操作记录");
    if (current.signal.aborted) return;
    events.value = body.data.events;
    total.value = body.data.total;
  } catch (cause) {
    if (!current.signal.aborted) failure.value = cause instanceof Error ? cause.message : "无法读取操作记录";
  } finally {
    if (request === current) loading.value = false;
  }
}

watch([visible, offset], () => {
  if (visible.value) void load();
  else request?.abort();
});
onBeforeUnmount(() => request?.abort());
</script>

<style scoped lang="scss">
.accountAudit {
  display: flex;
  flex-direction: column;
  gap: 16px;

  .auditNote { margin: 0; line-height: 1.6; color: var(--el-text-color-secondary); }
  .auditToolbar, .auditPagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .auditError { color: var(--el-color-danger); margin: 0; }
  .auditItem {
    padding-bottom: 14px;
    border-bottom: 1px solid var(--el-border-color);
    p { margin: 8px 0; }
    time { font-size: 13px; color: var(--el-text-color-secondary); }
  }
}
</style>
