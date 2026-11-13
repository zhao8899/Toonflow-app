<template>
  <el-dialog v-model="visible" title="任务成本核对" width="min(600px, 95vw)" appendToBody :closeOnClickModal="!saving" :showClose="!saving" :closeOnPressEscape="!saving">
    <p>人工记录供应商账单，不执行扣款或退款。未记录表示费用未知；仅保留最近100次修改。续查原任务不会自动更新账单金额，费用变化须重新核对。</p>
    <p v-if="!loading && loaded && !current">费用未知，尚未核对。</p>
    <el-form labelPosition="top" :disabled="loading || saving || !loaded">
      <el-form-item label="核对状态"><el-select v-model="status"><el-option label="已核对" value="confirmed" /><el-option label="待处理 / 有争议" value="disputed" /></el-select></el-form-item>
      <el-form-item label="金额（待处理时可留空，未知不等于0）"><el-input v-model="amount" :maxlength="19" placeholder="例如 0.125，最多6位小数" /></el-form-item>
      <el-form-item label="币种"><el-select v-model="currency"><el-option label="人民币 CNY" value="CNY" /><el-option label="美元 USD" value="USD" /></el-select></el-form-item>
      <el-form-item label="核对依据"><el-input v-model="source" :maxlength="500" placeholder="账单编号、账单时间或人工核对依据，请勿填写密钥" /></el-form-item>
      <el-form-item label="说明"><el-input v-model="note" type="textarea" :maxlength="2000" showWordLimit /></el-form-item>
    </el-form>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <el-collapse v-if="history.length"><el-collapse-item title="修改历史" name="history">
      <div v-for="entry in history" :key="entry.revision" class="costEntry">
        <strong>{{ entry.status === 'confirmed' ? '已核对' : '待处理 / 有争议' }} · {{ entry.amount === null ? '金额未知' : `${entry.amount} ${entry.currency}` }}</strong>
        <p>第{{ entry.revision }}次 · {{ entry.actor?.username ?? '本地操作者（未认证）' }} · {{ new Date(entry.recordedAt).toLocaleString() }}</p>
        <p>{{ entry.source }}</p><p>{{ entry.note }}</p>
      </div>
    </el-collapse-item></el-collapse>
    <template #footer><el-button :disabled="saving || loading" @click="reload">重新读取</el-button><el-button type="primary" :disabled="!loaded || loading || needsReload" :loading="saving" @click="save">保存核对</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import { ElMessageBox } from "element-plus";
import { authRequired, userRole } from "@/lib/auth";

type Cost = { revision: number; status: "confirmed" | "disputed"; amount: string | null; currency: "CNY" | "USD"; source: string; note: string; recordedAt: number; actor: { id: string; username: string } | null };
const props = defineProps<{ directory?: string; projectId?: string; taskId: string }>();
const visible = defineModel<boolean>({ default: false });
const current = ref<Cost | null>(null), history = ref<Cost[]>([]);
const status = ref<Cost["status"]>("disputed"), amount = ref(""), currency = ref<Cost["currency"]>("CNY"), source = ref(""), note = ref("");
const error = ref(""), loading = ref(false), saving = ref(false), loaded = ref(false);
const notice = ref(""), needsReload = ref(false);
const context = computed(() => JSON.stringify([visible.value, props.directory, props.projectId, props.taskId, authRequired.value, userRole.value]));
let controller: AbortController | undefined;
function headers() { return { "x-toonflow-workspace": "1", ...(props.projectId ? { "x-toonflow-project-id": props.projectId } : {}) }; }
function message(cause: unknown) { return axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "成本核对失败"; }
function apply(data: { current: Cost | null; history: Cost[] }) {
  current.value = data.current; history.value = data.history;
  status.value = data.current?.status ?? "disputed"; amount.value = data.current?.amount ?? "";
  currency.value = data.current?.currency ?? "CNY"; source.value = data.current?.source ?? ""; note.value = data.current?.note ?? "";
  loaded.value = true;
  needsReload.value = false;
}
async function reload() {
  if (saving.value || loading.value || !visible.value) return;
  const snapshot = context.value;
  const previous = controller;
  try {
    await ElMessageBox.confirm("重新读取会用最新记录替换当前填写内容，未保存的草稿将丢失。是否继续？", "读取最新成本记录", { confirmButtonText: "读取并替换", cancelButtonText: "保留草稿", type: "warning" });
    if (snapshot === context.value && controller === previous && !previous?.signal.aborted) await load();
  } catch (cause) { if (snapshot === context.value && controller === previous && !previous?.signal.aborted && cause !== "cancel" && cause !== "close") error.value = message(cause); }
}
async function load() {
  if (!visible.value || !props.directory || !props.taskId || saving.value || (authRequired.value && userRole.value !== "admin")) return;
  controller?.abort(); const request = new AbortController(); controller = request;
  const snapshot = context.value; loading.value = true; loaded.value = false; error.value = ""; notice.value = "";
  try {
    const { data } = await axios.get("/api/ai/media/tasks/costHistory", { params: { directory: props.directory, id: props.taskId }, headers: headers(), signal: request.signal, timeout: 15000 });
    if (request.signal.aborted || snapshot !== context.value) return;
    if (data.code !== 200) throw new Error(data.message);
    apply(data.data);
  } catch (cause) { if (!request.signal.aborted && snapshot === context.value) error.value = message(cause); }
  finally { if (controller === request) loading.value = false; }
}
async function save() {
  if (!loaded.value || saving.value || loading.value || needsReload.value || !visible.value || !props.directory || (authRequired.value && userRole.value !== "admin")) return;
  if (!source.value.trim() || (status.value === "confirmed" && !amount.value.trim()) || (amount.value.trim() && !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(amount.value.trim()))) { error.value = "请填写核对依据和有效金额；待处理记录可留空金额。"; return; }
  const request = new AbortController(); controller?.abort(); controller = request;
  const snapshot = context.value; saving.value = true; error.value = ""; notice.value = "";
  try {
    const { data } = await axios.put("/api/ai/media/tasks/cost", { directory: props.directory, id: props.taskId, revision: current.value?.revision ?? 0, status: status.value, amount: amount.value.trim() || null, currency: currency.value, source: source.value, note: note.value }, { headers: headers(), signal: request.signal, timeout: 15000 });
    if (request.signal.aborted || snapshot !== context.value) return;
    if (data.code !== 200) throw new Error(data.message);
    apply(data.data);
    notice.value = `核对记录已保存（第 ${data.data.current.revision} 次），未执行扣款或退款。`;
  } catch (cause) {
    if (!request.signal.aborted && snapshot === context.value) {
      needsReload.value = true;
      error.value = `${message(cause)}。请先重新读取核实最新记录，再决定是否提交；当前草稿暂时保留。`;
    }
  }
  finally { if (controller === request) saving.value = false; }
}
watch(context, (_value, _previous, cleanup) => {
  controller?.abort(); controller = undefined; current.value = null; history.value = [];
  loaded.value = false; loading.value = false; saving.value = false; error.value = ""; notice.value = ""; needsReload.value = false;
  amount.value = ""; source.value = ""; note.value = "";
  void load(); cleanup(() => controller?.abort());
}, { immediate: true, flush: "sync" });
watch([status, amount, currency, source, note], () => { notice.value = ""; }, { flush: "sync" });
</script>

<style scoped lang="scss">
.costEntry { border-bottom: 1px solid var(--el-border-color); padding: 8px 0; overflow-wrap: anywhere; p { white-space: pre-wrap; } }
</style>
