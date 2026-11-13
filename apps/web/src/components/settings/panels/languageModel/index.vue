<template>
  <div class="providerList">
    <p>先配置聚合平台的接口地址、协议和 API Key，再获取并选择文本模型。保存配置不会调用生成接口。</p>
    <el-form labelPosition="top">
      <el-form-item label="视频提示词辅助模型">
        <el-select :modelValue="enhancementModelValue" filterable clearable :disabled="savingEnhancementModel" placeholder="搜索并选择供应商模型" aria-label="视频提示词辅助模型" @change="saveEnhancementModel">
          <el-option v-if="invalidEnhancementModel" :value="enhancementModelValue" :label="`已配置模型不可用：${enhancementModelValue}`" disabled />
          <el-option v-for="model in modelChoices" :key="model.value" :value="model.value" :label="`${customProviders.find(provider => provider.id === model.providerId)?.label || model.providerId} · ${model.label}`" />
        </el-select>
        <p>仅在用户点击“帮我完善”时调用此文本模型，可能产生费用。清空后停用辅助；仍可直接生成视频。</p>
        <div v-if="enhancementModelValue && !invalidEnhancementModel">
          <el-checkbox :modelValue="enhancementImageInput" :disabled="savingEnhancementModel" @change="value => saveEnhancementInput('imageInput', value === true)">支持图片输入</el-checkbox>
          <el-checkbox :modelValue="enhancementVideoInput" :disabled="savingEnhancementModel" @change="value => saveEnhancementInput('videoInput', value === true)">支持视频输入</el-checkbox>
          <p>默认仅处理文字；确认当前模型和接口支持对应素材后再开启，切换模型将重置。</p>
        </div>
      </el-form-item>
    </el-form>
    <div class="itemList">
      <el-card v-for="item in sortedProviders" :key="item.id" class="providerItem" shadow="never">
        <div class="providerHeader">
          <div v-if="item.icon || isTfRouterProvider(item)" class="providerMark" aria-hidden="true">
            <img class="providerLogo" :class="{ monochrome: isTfRouterProvider(item) }" :src="item.icon || logoUrl" alt="" />
          </div>
          <div class="providerInfo">
            <div class="providerHeading">
              <el-text class="providerName" tag="strong">{{ item.label }}</el-text>
              <el-tag v-if="isTfRouterProvider(item)" size="small">官方</el-tag>
            </div>
            <el-text class="providerId" size="small" type="info" :title="item.id">{{ item.id }}</el-text>
          </div>
        </div>
        <p><el-text size="small" type="info">应用配置已保存 · 连接与模型调用未验证</el-text></p>
        <tfAccount v-if="isTfRouterProvider(item) && accountProviderId === item.id && visible" :apiKey="typeof item.apiKey === 'string' ? item.apiKey : ''" :visible="visible" :saveApiKey="(key) => saveProviderApiKey(item.id, key)" />
        <div class="providerFooter">
          <div class="providerMeta">
            <el-tag v-if="getProviderVersion(item)" size="small" type="info" effect="plain">v{{ getProviderVersion(item) }}</el-tag>
            <el-text size="small" type="info">{{ item.models.length }} 个模型</el-text>
          </div>
          <el-space class="itemActions" wrap>
            <el-button type="primary" :icon="IconEdit" :disabled="!!deletingId" @click="openCustomProvider(item)">配置连接</el-button>
            <el-button :disabled="!!deletingId" @click="openCustomProvider(item, true)">选择平台模型</el-button>
            <el-button v-if="isTfRouterProvider(item)" text :aria-expanded="accountProviderId === item.id" @click="accountProviderId = accountProviderId === item.id ? '' : item.id">{{ accountProviderId === item.id ? "收起账户" : "查看账户（查询平台余额）" }}</el-button>
            <el-popconfirm title="确定删除此供应商及其模型？" confirmButtonText="删除" cancelButtonText="取消" @confirm="deleteProvider(item.id)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :loading="deletingId === item.id" :disabled="!!deletingId">删除</el-button></template>
            </el-popconfirm>
          </el-space>
        </div>
      </el-card>
    </div>
    <div class="providerActions">
      <el-button class="addButton" :icon="IconSettings" @click="openCustomProvider()">接入聚合平台</el-button>
    </div>
    <p>“选择平台模型”仅读取平台模型列表，不调用生成；列表可读取不代表模型调用已验证。已有模型不会自动替换。</p>
    <component :is="addCustomProviderDialog" v-model="customProviderDialogVisible" :provider="editingProvider" :loadModels="loadModelsOnOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef, watch, type Component } from "vue";
import { ElMessage } from "element-plus";
import { customProviders, settings, modelChoices, saveSettings, type CustomProvider } from "@/stores/settings";
import { IconSettings, IconEdit, IconTrash } from "@tabler/icons-vue";
import { languageProviders } from "@toonflow/providers";
import logoUrl from "@toonflow/assets/logo.svg";
import tfAccount from "../../tfAccount.vue";
import { isTfRouterProvider } from "@/lib/tf";

const { visible = true } = defineProps<{ visible?: boolean }>();

const addCustomProviderDialog = shallowRef<Component>();

const customProviderDialogVisible = ref(false);
const editingProvider = ref<CustomProvider>();
const loadModelsOnOpen = ref(false);
const deletingId = ref("");
const accountProviderId = ref("");
watch(() => visible, value => { if (!value) accountProviderId.value = ""; });
const sortedProviders = computed(() => [...customProviders.value].sort((a, b) => Number(isTfRouterProvider(b)) - Number(isTfRouterProvider(a))));

const savingEnhancementModel = ref(false);
const enhancementModelValue = computed(() => {
  const value = settings.value.promptEnhancementModel;
  if (value == null) return "";
  if (typeof value === "object" && "providerId" in value && "modelId" in value) return JSON.stringify([value.providerId, value.modelId]);
  return JSON.stringify(value) ?? "无效配置";
});
const invalidEnhancementModel = computed(() => !!enhancementModelValue.value && !modelChoices.value.some(model => model.value === enhancementModelValue.value));
const enhancementImageInput = computed(() => {
  const value = settings.value.promptEnhancementModel;
  return !!value && typeof value === "object" && "imageInput" in value && value.imageInput === true;
});
const enhancementVideoInput = computed(() => {
  const value = settings.value.promptEnhancementModel;
  return !!value && typeof value === "object" && "videoInput" in value && value.videoInput === true;
});
async function saveEnhancementInput(field: "imageInput" | "videoInput", enabled: boolean) {
  if (savingEnhancementModel.value || !enhancementModelValue.value || invalidEnhancementModel.value) return;
  const selected = enhancementModelValue.value;
  savingEnhancementModel.value = true;
  try {
    await saveSettings(current => {
      const value = current.promptEnhancementModel;
      if (!value || typeof value !== "object" || !("providerId" in value) || !("modelId" in value)
        || JSON.stringify([value.providerId, value.modelId]) !== selected) throw new Error("辅助模型已变更，请重新设置输入能力");
      const providers = current.customProviders as CustomProvider[] | undefined;
      if (!Array.isArray(providers) || !providers.some(provider => provider?.id === value.providerId && Array.isArray(provider.models) && provider.models.some(model => model?.id === value.modelId))) throw new Error("所选模型已不可用，请重新选择");
      return { promptEnhancementModel: { ...value, [field]: enabled } };
    });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存输入能力失败"); }
  finally { savingEnhancementModel.value = false; }
}
async function saveEnhancementModel(value: string) {
  if (savingEnhancementModel.value) return;
  savingEnhancementModel.value = true;
  try {
    await saveSettings(current => {
      if (!value) return { promptEnhancementModel: null };
      const [providerId, modelId] = JSON.parse(value);
      const providers = current.customProviders as CustomProvider[] | undefined;
      if (!Array.isArray(providers) || !providers.some(provider => provider?.id === providerId && Array.isArray(provider.models) && provider.models.some(model => model?.id === modelId))) throw new Error("所选模型已不可用，请重新选择");
      return { promptEnhancementModel: { providerId, modelId } };
    });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存辅助模型失败"); }
  finally { savingEnhancementModel.value = false; }
}

function getProviderVersion(provider: CustomProvider) {
  const version = languageProviders.find(item => item.id.toLowerCase() === provider.id.toLowerCase())?.version ?? provider.version;
  return typeof version === "string" ? version.trim() : "";
}



function openCustomProvider(provider?: CustomProvider, loadModels = false) {
  loadModelsOnOpen.value = loadModels;
  addCustomProviderDialog.value ??= defineAsyncComponent(() => import("./addCustomProviderDialog.vue"));
  editingProvider.value = provider;
  customProviderDialogVisible.value = true;
}

async function deleteProvider(id: string) {
  if (deletingId.value) return;
  deletingId.value = id;
  try {
    await saveSettings(settings => {
      const current = settings.customProviders;
      if (!Array.isArray(current)) throw new Error("配置格式错误");
      return { customProviders: current.filter(item => item?.id !== id) };
    });
  } catch { ElMessage.error("删除失败，请重试"); }
  finally { deletingId.value = ""; }
}

async function saveProviderApiKey(id: string, key: string) {
  const provider = customProviders.value.find(item => item.id === id);
  if (!provider) throw new Error("供应商已不存在");
  const { apiUrl, protocol, apiKey } = provider;
  await saveSettings(settings => {
    const current = settings.customProviders;
    if (!Array.isArray(current)) throw new Error("配置格式错误");
    const latest = current.find(item => item?.id === id);
    if (!latest) throw new Error("供应商已不存在");
    if (latest.apiUrl !== apiUrl || latest.protocol !== protocol || latest.apiKey !== apiKey) {
      throw new Error("供应商配置已变更，请重试");
    }
    return { customProviders: current.map(item => item?.id === id ? { ...item, apiKey: key } : item) };
  });
}

</script>

<style lang="scss" scoped src="../../providerList.scss"></style>
