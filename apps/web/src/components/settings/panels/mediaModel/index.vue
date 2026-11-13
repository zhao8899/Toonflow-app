<template>
  <div v-if="loaded || loading" class="providerList">
    <el-alert title="1. 接入平台 → 2. 配置连接 → 3. 在生成节点选择模型" description="先选择已支持的平台，再填写连接信息和管理模型。其他平台需要对应媒体接口适配，不能仅更换服务地址。" type="info" :closable="false" />
    <el-text v-if="loading" role="status" type="info">正在读取平台列表…</el-text>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" showIcon>
      <el-button :disabled="loading" @click="loadProviders">重新加载平台</el-button>
    </el-alert>
    <div class="itemList">
      <el-card v-for="item in sortedProviders" :key="item.fileName" class="providerItem" shadow="never">
        <div class="providerHeader">
          <div v-if="item.icon || item.id.toLowerCase() === 'tfrouter'" class="providerMark" aria-hidden="true">
            <img class="providerLogo" :class="{ monochrome: item.id.toLowerCase() === 'tfrouter' }" :src="item.icon || logoUrl" alt="" />
          </div>
          <div class="providerInfo">
            <div class="providerHeading">
              <el-text class="providerName" tag="strong">{{ item.label }}</el-text>
              <el-tag v-if="item.id.toLowerCase() === 'tfrouter'" size="small">官方</el-tag>
            </div>
            <el-text class="providerId" size="small" type="info" :title="item.fileName">{{ item.fileName }}</el-text>
          </div>
        </div>
        <el-alert v-if="item.loadError" :title="item.loadError" type="error" :closable="false" showIcon />
        <el-text size="small" type="info">{{ connectionStatus(item) }}（仅应用配置状态）</el-text>
        <el-alert v-if="refreshResults[item.fileName]" :title="refreshResults[item.fileName].message" type="info" :closable="false">
          <p>本次仅更新模型列表，不代表模型生成能力已验证。</p>
          <ul v-if="refreshResults[item.fileName].skipped.length">
            <li v-for="(entry, index) in refreshResults[item.fileName].skipped" :key="index">{{ entry.id }}：{{ entry.reason }}</li>
          </ul>
          <template v-if="refreshResults[item.fileName].skipped.length">
            <p>请向平台确认准确模型 ID、输入模式、时长与分辨率组合及音频支持，再填写模型配置；不要照搬其他型号的参数。</p>
            <el-button :aria-label="`核对并配置模型 ${item.label}`" :disabled="!!fetchingFile || !!deletingFile || !!item.loadError" @click="editProvider(item)">核对并配置模型</el-button>
          </template>
        </el-alert>
        <el-button v-if="item.id.toLowerCase() === 'tfrouter'" text @click="accountVisible = !accountVisible">{{ accountVisible ? '收起官方账户' : '查看官方账户' }}</el-button>
        <tfAccount v-if="item.id.toLowerCase() === 'tfrouter' && accountVisible" :apiKey="getProviderApiKey(item.id)" :visible="visible" :saveApiKey="(key) => saveProviderApiKey(item.id, key)" />
        <div class="providerFooter">
          <div class="providerMeta">
            <el-tag v-if="item.version" size="small" type="info" effect="plain">v{{ item.version }}</el-tag>
            <el-text size="small" type="info">{{ modelSummary(item) }}</el-text>
          </div>
          <el-space class="itemActions" wrap>
            <el-button v-if="item.modelsUrl" text :icon="IconDownload" :loading="fetchingFile === item.fileName" :disabled="!!fetchingFile || !!deletingFile || !!item.loadError || !item.revision" @click="fetchModels(item)">获取模型</el-button>
            <el-button text type="primary" :icon="IconEdit" :disabled="!!fetchingFile || !!deletingFile || !!item.loadError" @click="editProvider(item)">配置连接与模型</el-button>
            <el-popconfirm title="确定删除此供应商及其模型？" confirmButtonText="删除" cancelButtonText="取消" @confirm="deleteProvider(item)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :loading="deletingFile === item.fileName" :disabled="!!fetchingFile || !!deletingFile || !item.revision">删除</el-button></template>
            </el-popconfirm>
          </el-space>
        </div>
      </el-card>
    </div>
    <div class="providerActions">
      <el-button class="addButton" :icon="IconSettings" :disabled="loading" @click="openAdd('builtin')">选择已支持平台</el-button>
      <el-button class="addButton" :icon="IconSettings" :disabled="loading" @click="openAdd('custom')">接入其他平台</el-button>
    </div>
    <component :is="mediaProviderDialog" v-model="providerDialogVisible" :mode="addMode" @added="saveProviderItem" />
    <component :is="editProviderDialog" v-model="editorVisible" :provider="editingProvider" @saved="saveProviderItem" />
  </div>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref, shallowRef, watch, type Component } from "vue";
import { ElMessage } from "element-plus";
import { IconSettings, IconEdit, IconTrash, IconDownload } from "@tabler/icons-vue";
import logoUrl from "@toonflow/assets/logo.svg";
import type { MediaProvider } from "./types";
import { settings, saveSettings } from "@/stores/settings";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import tfAccount from "../../tfAccount.vue";

const { visible = true } = defineProps<{ visible?: boolean }>();
const mediaProviderDialog = shallowRef<Component>();
const editProviderDialog = shallowRef<Component>();
const providers = ref<MediaProvider[]>([]);
const sortedProviders = computed(() => [...providers.value].sort((a, b) => Number(b.id.toLowerCase() === "tfrouter") - Number(a.id.toLowerCase() === "tfrouter")));
const loaded = ref(false);
const loading = ref(false);
const loadError = ref("");
const accountVisible = ref(false);
watch(() => visible, value => { if (!value) accountVisible.value = false; });
const providerDialogVisible = ref(false);
const editorVisible = ref(false);
const addMode = ref<"builtin" | "custom">("builtin");
const editingProvider = ref<MediaProvider>();
const deletingFile = ref("");
const fetchingFile = ref("");
const refreshResults = ref<Record<string, { message: string; skipped: { id: string; reason: string }[] }>>({});
let loadRequest = 0;

function modelSummary(provider: MediaProvider) {
  return ([["image", "图片"], ["video", "视频"], ["audio", "音频"], ["text", "文本"]] as const)
    .map(([type, label]) => `${label} ${provider.models.filter(model => model.type === type).length}`).join(" · ");
}

function connectionStatus(provider: MediaProvider) {
  if (getProviderApiKey(provider.id).trim()) return "API Key 已填写 · 连接未验证";
  return provider.rules?.some(rule => rule.field === "apiKey") ? "未填写 API Key" : "请按平台要求配置 · 连接未验证";
}

function getProviderApiKey(id: string) {
  const configs = settings.value.mediaProviderConfigs as Record<string, { apiKey?: unknown }> | undefined;
  const apiKey = configs?.[id]?.apiKey;
  return typeof apiKey === "string" ? apiKey : "";
}

async function saveProviderApiKey(id: string, key: string) {
  await saveSettings(settings => {
    const configs = settings.mediaProviderConfigs;
    const current = configs && typeof configs === "object" && !Array.isArray(configs) ? configs as Record<string, unknown> : {};
    const existing = current[id];
    const config = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
    return { mediaProviderConfigs: { ...current, [id]: { ...config, apiKey: key } } };
  });
}

function refreshInstalled(event: WindowEventMap["toonflow:plugin-installed"]) {
  if (event.detail.type === "provider") void loadProviders();
}
onMounted(() => {
  void loadProviders();
  window.addEventListener("toonflow:plugin-installed", refreshInstalled);
});
onBeforeUnmount(() => {
  loadRequest++;
  window.removeEventListener("toonflow:plugin-installed", refreshInstalled);
});

async function loadProviders() {
  const request = ++loadRequest;
  loading.value = true;
  try {
    const { data } = await axios.get<{ code: number; data: MediaProvider[] }>("/api/providers/media/list", { timeout: 15000 });
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error("读取平台列表失败");
    if (request === loadRequest) { providers.value = data.data; loadError.value = ""; }
  } catch (error) {
    if (request === loadRequest) loadError.value = "读取平台列表失败，请重新加载；当前无法确认已接入的平台。";
  } finally {
    if (request === loadRequest) { loaded.value = true; loading.value = false; }
  }
}

function openAdd(mode: "builtin" | "custom") {
  mediaProviderDialog.value ??= defineAsyncComponent(() => import("./addCustomProviderDialog.vue"));
  addMode.value = mode;
  providerDialogVisible.value = true;
}

function editProvider(provider: MediaProvider) {
  if (fetchingFile.value || deletingFile.value || provider.loadError) return;
  editProviderDialog.value ??= defineAsyncComponent(() => import("./editProviderDialog.vue"));
  editingProvider.value = provider;
  editorVisible.value = true;
}

async function fetchModels(provider: MediaProvider) {
  if (fetchingFile.value || deletingFile.value || !provider.modelsUrl || !provider.revision || provider.loadError) return;
  fetchingFile.value = provider.fileName;
  try {
    const { data } = await axios.post<{ code: number; data: MediaProvider; message: string }>("/api/providers/media/models", {
      fileName: provider.fileName, revision: provider.revision,
    }, { timeout: 35000 });
    if (data.code !== 200 || !data.data) throw new Error("获取模型失败");
    saveProviderItem(data.data);
    invalidateNodeModels("media");
    const summary = data.data.refreshSummary;
    const validSummary = summary && Number.isSafeInteger(summary.imported) && summary.imported >= 0
      && Number.isSafeInteger(summary.preserved) && summary.preserved >= 0 && Array.isArray(summary.skipped)
      && summary.skipped.every(entry => entry && typeof entry.id === "string" && typeof entry.reason === "string");
    const message = validSummary
      ? `本次导入或更新 ${summary.imported} 个，跳过 ${summary.skipped.length} 个，保留原配置 ${summary.preserved} 个（数量可能重叠）。`
      : "模型列表已读取；当前响应未提供导入、跳过和保留统计，请检查模型配置。";
    const knownReasons = ["缺少明确类型及已有配置，未推测生成能力", "不是支持的媒体类型", "目录类型与已有配置不一致", "与请求的媒体类型不匹配", "新视频模型缺少明确模式、时长分辨率或音频能力，保留人工配置"];
    refreshResults.value[provider.fileName] = { message, skipped: validSummary ? summary.skipped.map(entry => ({
      id: entry.id,
      reason: knownReasons.includes(entry.reason) ? entry.reason : "未满足安全导入条件，请核对平台能力与适配器支持情况。",
    })) : [] };
    ElMessage.info(message);
  } catch (error) {
    const message = "获取模型失败，请检查连接配置后重试；本次无法确认模型列表更新结果。";
    refreshResults.value[provider.fileName] = { message, skipped: [] };
    ElMessage.error(message);
  } finally { fetchingFile.value = ""; }
}

async function deleteProvider(provider: MediaProvider) {
  if (fetchingFile.value || deletingFile.value || !provider.revision) return;
  deletingFile.value = provider.fileName;
  let deleted = false;
  try {
    await axios.delete("/api/providers/media/delete", { data: { fileName: provider.fileName, revision: provider.revision } });
    deleted = true;
    loadRequest++;
    loading.value = false;
    invalidateNodeModels("media");
    providers.value = providers.value.filter(item => item.fileName !== provider.fileName);
    await saveSettings(settings => {
      const configs = settings.mediaProviderConfigs;
      if (!configs || typeof configs !== "object" || Array.isArray(configs) || !Object.hasOwn(configs, provider.id)) return;
      const current = { ...configs } as Record<string, unknown>;
      delete current[provider.id];
      return { mediaProviderConfigs: current };
    });
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "删除失败，请重试";
    ElMessage.error(deleted ? `供应商已删除，连接配置未清理：${message}` : message);
  } finally { deletingFile.value = ""; }
}

function saveProviderItem(provider: MediaProvider) {
  loadRequest++;
  loading.value = false;
  const index = providers.value.findIndex(item => item.fileName === provider.fileName);
  if (index < 0) providers.value.push(provider);
  else providers.value.splice(index, 1, provider);
}
</script>

<style lang="scss" scoped src="../../providerList.scss"></style>
