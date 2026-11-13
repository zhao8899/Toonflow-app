<template>
  <el-dialog
    v-model="visible"
    :title="provider ? '配置平台连接' : '接入聚合平台'"
    width="min(760px, 94vw)"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving"
    :showClose="!saving"
    @opened="loadModels && fetchModels()"
    @closed="resetForm">
    <el-scrollbar maxHeight="65vh">
      <p>按平台提供的接入说明填写连接信息。保存仅更新应用配置，不验证连通性，也不调用模型。</p>
      <el-form ref="providerForm" :model="form" :rules="rules" labelPosition="top" :disabled="saving" class="customProviderForm">
        <div class="formGrid">
          <el-form-item label="1. 平台名称" prop="label"><el-input v-model="form.label" placeholder="填写便于识别的平台名称" /></el-form-item>
          <el-form-item label="Provider ID（本地标识）" prop="id">
            <el-input v-model="form.id" placeholder="例如 myProvider" />
            <el-text size="small" type="info">用于区分平台配置，不是 API Key；须唯一，已有标识请谨慎修改。</el-text>
          </el-form-item>
          <el-form-item label="2. 接口基础地址" prop="apiUrl">
            <el-input v-model="form.apiUrl" dir="ltr" placeholder="https://api.example.com/v1" />
            <el-text size="small" type="info">使用平台提供的基础地址，不填写完整的模型生成接口路径。</el-text>
          </el-form-item>
          <el-form-item label="3. API 协议" prop="protocol">
            <el-select v-model="form.protocol" aria-label="API 协议">
              <el-option v-for="protocol in protocols" :key="protocol" :label="protocol" :value="protocol" />
            </el-select>
            <el-text size="small" type="info">按平台接入说明选择；OpenAI Chat Completions 对应 openai-completions。</el-text>
          </el-form-item>
        </div>
        <el-form-item label="4. API Key" prop="apiKey">
          <el-input v-model="form.apiKey" type="password" dir="ltr" showPassword autocomplete="off" placeholder="本地无鉴权服务可留空" />
          <el-text size="small" type="info">粘贴此平台签发的密钥；仅无鉴权服务可留空。</el-text>
        </el-form-item>
        <div class="modelHeader">
          <el-text tag="strong">5. 获取并选择文本模型</el-text>
          <el-button :icon="IconDownload" :loading="fetching" @click="fetchModels()">获取模型列表</el-button>
        </div>
        <p>获取模型仅读取平台列表，不调用生成接口；可搜索勾选，也可手动填写平台提供的模型 ID。读取列表成功不代表模型调用已验证。</p>
        <el-alert v-if="discoveryComplete" :title="discoveryMessage" :type="fetchedModels.length ? 'info' : 'warning'" :closable="false" showIcon />
        <el-alert v-if="missingSavedModels.length" title="当前配置的部分模型本次未返回" :description="`列表缺席不能证明模型失效，也不能据此判断别名对应关系。请向平台核对准确 ID，不按名称自动替换：${missingSavedModels.map(item => item.id).join('、')}`" type="warning" :closable="false" showIcon />
        <div class="modelList">
          <div v-for="item in models" :key="item.key" class="modelItem">
            <div class="modelRow">
              <el-input v-model="item.id" placeholder="模型 ID" aria-label="模型 ID" />
              <el-input v-model="item.label" placeholder="显示名称" aria-label="模型显示名称" />
              <el-button
                text
                :icon="expandedModels.has(item.key) ? IconChevronUp : IconChevronDown"
                :aria-expanded="expandedModels.has(item.key)"
                aria-label="展开 token 设置"
                @click="expandedModels.has(item.key) ? expandedModels.delete(item.key) : expandedModels.add(item.key)" />
              <el-button
                text
                type="danger"
                :icon="IconTrash"
                aria-label="删除模型"
                @click="models = models.filter((model) => model.key !== item.key)" />
            </div>
            <div v-if="expandedModels.has(item.key)" class="formGrid tokenSettings">
              <el-form-item label="上下文窗口">
                <el-input-number
                  v-model="item.contextWindow"
                  :min="1"
                  :max="Number.MAX_SAFE_INTEGER"
                  :precision="0"
                  controlsPosition="right"
                  placeholder="未设置"
                  aria-label="上下文窗口" />
              </el-form-item>
              <el-form-item label="最大输出 token">
                <el-input-number
                  v-model="item.maxOutputTokens"
                  :min="1"
                  :max="Number.MAX_SAFE_INTEGER"
                  :precision="0"
                  controlsPosition="right"
                  placeholder="未设置"
                  aria-label="最大输出 token" />
              </el-form-item>
            </div>
          </div>
        </div>
        <el-button class="manualAdd" :icon="IconPlus" @click="addManualModel">手动添加模型</el-button>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" showIcon />
      </el-form>
    </el-scrollbar>
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="fetching" @click="addProvider">
        保存配置
      </el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="resultsVisible" title="选择要添加的模型" width="min(680px, 92vw)" alignCenter appendToBody destroyOnClose>
    <p>此处用于文本对话和提示词辅助，请选择支持文本对话的模型。平台返回的图片、视频模型需在媒体模型中配置。</p>
    <el-alert v-if="discoveryComplete" :title="discoveryMessage" :type="fetchedModels.length ? 'info' : 'warning'" :closable="false" />
    <el-alert v-if="missingSavedModels.length" title="当前配置的部分模型本次未返回" :description="`列表缺席不能证明模型失效，也不能据此判断别名对应关系。请向平台核对准确 ID，不按名称自动替换：${missingSavedModels.map(item => item.id).join('、')}`" type="warning" :closable="false" />
    <el-input v-model="modelSearch" clearable :prefixIcon="IconSearch" placeholder="搜索模型 ID 或显示名称" aria-label="搜索模型" />
    <div class="modelResults">
      <el-auto-resizer>
        <template #default="{ height, width }">
          <el-table-v2
            :columns="resultColumns"
            :data="filteredModels"
            :width="width"
            :height="height"
            :rowHeight="38"
            :headerHeight="36"
            rowKey="id"
            fixed />
        </template>
      </el-auto-resizer>
    </div>
    <el-text type="info">{{ filteredModels.length }} 个结果，已勾选 {{ selectedIds.size }} 个</el-text>
    <template #footer>
      <el-button @click="resultsVisible = false">取消</el-button>
      <el-button type="primary" :disabled="!selectedIds.size" @click="addSelectedModels">添加勾选的模型（{{ selectedIds.size }}）</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { ElCheckbox, type FormInstance, type FormRules, type Column } from "element-plus";
import {
  IconPlus,
  IconDownload,
  IconTrash,
  IconChevronDown,
  IconChevronUp,
  IconSearch,
} from "@tabler/icons-vue";
import { saveSettings, type CustomProvider, type CustomProviderModel } from "@/stores/settings";
import { languageProviders } from "@toonflow/providers";

const props = defineProps<{ provider?: CustomProvider; loadModels?: boolean }>();
const visible = defineModel<boolean>({ default: false });
const providerForm = ref<FormInstance>();
const form = reactive({ id: "", label: "", apiUrl: "", protocol: "openai-completions", apiKey: "" });
const models = ref<(CustomProviderModel & { key: string })[]>([]);
const expandedModels = ref(new Set<string>());
const fetchedModels = shallowRef<CustomProviderModel[]>([]);
const discoveryComplete = ref(false);
const discoveryMessage = computed(() => `${form.apiKey.trim() ? "已携带 API Key 读取列表成功" : "列表读取成功（未提供 API Key）"}，不代表模型调用成功。${fetchedModels.value.length ? `本次返回 ${fetchedModels.value.length} 个文本模型，请手动勾选。` : "本次未返回文本模型，请核对平台提供的模型范围；原配置未改动。"}`);
const missingSavedModels = computed(() => discoveryComplete.value
  ? models.value.filter(item => item.id.trim() && !fetchedModels.value.some(model => model.id === item.id.trim())) : []);
const selectedIds = ref(new Set<string>());
const modelSearch = ref("");
const saving = ref(false);
const protocols = ["openai-completions", "openai-responses", "anthropic-messages"];
const addedIds = computed(() => new Set(models.value.map((item) => item.id.trim())));
const filteredModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase();
  return query ? fetchedModels.value.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(query)) : fetchedModels.value;
});
const resultColumns = computed<Column[]>(() => [
  {
    key: "selection",
    width: 42,
    cellRenderer: ({ rowData }) =>
      h(ElCheckbox, {
        modelValue: selectedIds.value.has(rowData.id),
        disabled: addedIds.value.has(rowData.id),
        ariaLabel: `选择 ${rowData.id}`,
        onChange: (value: boolean | string | number) => {
          if (value) selectedIds.value.add(rowData.id);
          else selectedIds.value.delete(rowData.id);
        },
      }),
  },
  { key: "id", dataKey: "id", title: "模型 ID", width: 240, flexGrow: 1 },
  { key: "label", dataKey: "label", title: "显示名称", width: 200, flexGrow: 1 },
]);
const resultsVisible = ref(false);
const fetching = ref(false);
const formError = ref("");
let request: AbortController | undefined;
const rules: FormRules = {
  id: [
    { required: true, message: "请输入 Provider ID", trigger: "blur" },
    { pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, message: "仅支持字母、数字、点、下划线和短横线", trigger: "blur" },
  ],
  label: [{ required: true, whitespace: true, message: "请输入显示名称", trigger: "blur" }],
  apiUrl: [
    {
      validator: (_rule, value, callback) => {
        try {
          const url = new URL(value);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
          callback();
        } catch {
          callback(new Error("请输入有效的 HTTP API 基础地址，不包含查询参数"));
        }
      },
      trigger: "blur",
    },
  ],
};

watch(visible, (value) => {
  if (value) {
    resetForm();
    if (props.provider) {
      const { models: providerModels, id, label, apiUrl, protocol, apiKey } = props.provider;
      Object.assign(form, { id, label, apiUrl, protocol, apiKey });
      models.value = providerModels.map((item) => ({ ...item, key: crypto.randomUUID() }));
    }
  } else {
    clearDiscovery();
  }
}, { immediate: true });
onBeforeUnmount(() => request?.abort());
watch([() => form.id, () => form.apiUrl, () => form.protocol, () => form.apiKey], clearDiscovery, { flush: "sync" });

function clearDiscovery() {
  request?.abort();
  request = undefined;
  fetching.value = false;
  discoveryComplete.value = false;
  fetchedModels.value = [];
  selectedIds.value = new Set();
  resultsVisible.value = false;
}

function resetForm() {
  clearDiscovery();
  Object.assign(form, { id: "", label: "", apiUrl: "", protocol: "openai-completions", apiKey: "" });
  models.value = [];
  expandedModels.value = new Set();
  fetchedModels.value = [];
  selectedIds.value = new Set();
  modelSearch.value = "";
  formError.value = "";
}

async function fetchModels() {
  if (fetching.value || !visible.value) return;
  clearDiscovery();
  fetching.value = true;
  formError.value = "";
  const controller = new AbortController();
  request = controller;
  try {
    if (!(await providerForm.value?.validateField("apiUrl").catch(() => false)) || controller.signal.aborted || request !== controller || !visible.value) return;
    const { data } = await axios.post(
      "/api/providers/models",
      { apiUrl: form.apiUrl.trim(), protocol: form.protocol, apiKey: form.apiKey.trim() },
      { signal: controller.signal, timeout: 35000 }
    );
    if (controller.signal.aborted || request !== controller || !visible.value) return;
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || "获取模型列表失败");
    if (data.data.some((item: unknown) => !item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id.trim()
      || !("label" in item) || typeof item.label !== "string")) throw new Error("平台返回的模型列表格式无效");
    fetchedModels.value = data.data;
    discoveryComplete.value = true;
    selectedIds.value = new Set();
    modelSearch.value = "";
    resultsVisible.value = true;
  } catch (error) {
    if (!controller.signal.aborted && request === controller) {
      formError.value = axios.isAxiosError(error)
        ? error.response?.data?.message || "获取模型列表失败，请检查连接配置"
        : error instanceof Error
        ? error.message
        : "获取模型列表失败";
    }
  } finally {
    if (request === controller) fetching.value = false;
  }
}

function addSelectedModels() {
  const added = new Set(addedIds.value);
  for (const item of fetchedModels.value) {
    if (selectedIds.value.has(item.id) && !added.has(item.id)) {
      models.value.push({ ...item, key: crypto.randomUUID() });
      added.add(item.id);
    }
  }
  resultsVisible.value = false;
}

function addManualModel() {
  const key = crypto.randomUUID();
  models.value.push({ key, id: "", label: "" });
}

async function addProvider() {
  if (fetching.value) return;
  formError.value = "";
  if (saving.value || !(await providerForm.value?.validate().catch(() => false))) return;
  const providerId = props.provider?.id;
  const ids = models.value.map((item) => item.id.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    formError.value = "模型 ID 不能为空或重复";
    return;
  }
  if (
    models.value.some((item) =>
      [item.contextWindow, item.maxOutputTokens].some((value) => value != null && (!Number.isSafeInteger(value) || value < 1))
    )
  ) {
    formError.value = "token 限制必须为正整数或留空";
    return;
  }
  saving.value = true;
  try {
    const updatedProvider = {
      ...form,
      label: form.label.trim(),
      apiUrl: form.apiUrl.trim(),
      apiKey: form.apiKey.trim(),
      models: models.value.map(({ key, ...item }) => ({
        ...item,
        id: item.id.trim(),
        label: item.label.trim() || item.id.trim(),
        contextWindow: item.contextWindow ?? undefined,
        maxOutputTokens: item.maxOutputTokens ?? undefined,
      })),
    };
    await saveSettings(settings => {
      const existing = settings.customProviders;
      if (existing !== undefined && !Array.isArray(existing)) throw new Error("已保存的供应商配置格式不正确");
      if (languageProviders.some(item => item.id !== providerId && item.id.toLowerCase() === updatedProvider.id.toLowerCase())
        || existing?.some(item => typeof item?.id === "string" && item.id !== providerId && item.id.toLowerCase() === updatedProvider.id.toLowerCase())) {
        throw new Error("Provider ID 已存在");
      }
      if (providerId && !existing?.some(item => item.id === providerId)) throw new Error("供应商已不存在");
      return { customProviders: providerId
        ? existing!.map(item => item.id === providerId ? { ...item, ...updatedProvider } : item)
        : [...(existing ?? []), updatedProvider] };
    });
    visible.value = false;
  } catch (error) {
    formError.value = error instanceof Error ? error.message : "保存失败，请重试；当前填写的内容已保留";
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.customProviderForm {
  padding-right: 12px;

  .formGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 20px;

    .el-input-number {
      width: 100%;
    }
  }

  .modelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 8px 0 16px;
  }

  .modelList {
    .modelItem {
      padding: 8px 0;
      border-bottom: 1px solid var(--el-border-color-lighter);

      .modelRow {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px 28px;
        align-items: center;
        gap: 8px;

        .el-button {
          margin: 0;
          padding: 4px;
        }
      }

      .tokenSettings {
        padding-top: 12px;

        .el-form-item {
          margin-bottom: 4px;
        }
      }
    }
  }

  .manualAdd {
    width: 100%;
    margin: 16px 0;
  }

  @media (max-width: 560px) {
    .formGrid {
      grid-template-columns: 1fr;
    }
  }
}
.modelResults {
  height: min(420px, 55dvh);
  margin: 12px 0;
}
</style>
