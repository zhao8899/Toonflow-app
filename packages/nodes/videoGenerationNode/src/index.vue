<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="660"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }">
    <template #topActions>
      <el-button :icon="IconMusic" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('extractAudio')">提取音轨</el-button>
      <el-button :icon="IconLayersSubtract" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('separate')">分离音视频</el-button>
      <el-button :icon="IconScissors" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('trim')">截取片段</el-button>
      <mediaHistory mediaType="video" :current="outputFile" :disabled="generating || deleting || uploading" @select="outputs.video = { dataType: 'VIDEO', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting" text title="替换视频" aria-label="替换视频" @click.stop="fileInput?.click()">替换视频</el-button>
      <input ref="fileInput" type="file" accept="video/*" hidden aria-label="选择替换视频" :disabled="generating || deleting || uploading" @change="replaceOutput" />
    </template>
    <template #topRightActions>
      <el-dropdown trigger="click" placement="bottom-end" :disabled="!player?.ready || player?.capturing || generating || deleting || uploading" @command="player?.captureFrame($event)">
        <el-button :icon="IconPhotoScan" :loading="player?.capturing" :disabled="!player?.ready || player?.capturing || generating || deleting || uploading" text title="截取视频帧" aria-label="截取视频帧" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="current" :icon="IconPhotoScan">截取当前帧</el-dropdown-item>
            <el-dropdown-item command="first" :icon="IconPlayerSkipBack">截取首帧</el-dropdown-item>
            <el-dropdown-item command="last" :icon="IconPlayerSkipForward">截取尾帧</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>
    <div v-loading="generating || uploading" class="videoContent nopan" :aria-busy="generating || uploading">
      <videoPlayer
        v-if="previewUrl"
        ref="player"
        :src="previewUrl"
        label="生成视频"
        @loadedmetadata="resizeVideo" />
      <div v-else class="videoEmpty" role="img" aria-label="暂无生成视频">
        <icon-camera-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <div v-if="frameMode" class="referenceHint">
          {{ selectedMode === "startFrameOptional" ? "仅一张图片时作为尾帧；两张图片按顺序作为首帧、尾帧" : "图片引用按顺序作为首帧、尾帧" }}
        </div>
        <promptInput v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <div class="promptAssistance">
          <el-button text :loading="enhancingPrompt" :disabled="!!enhancementDisabledReason || enhancingPrompt" @click="improvePrompt">帮我完善</el-button>
          <el-button v-if="originalPrompt" text :disabled="generating || deleting || enhancingPrompt" @click="restorePrompt">恢复原文</el-button>
          <p class="referenceHint">可选辅助会调用已配置的文本模型，可能产生费用。请审阅完善结果后再生成。</p>
          <p v-if="enhancementDisabledReason" class="referenceHint">{{ enhancementDisabledReason }}</p>
          <p v-if="enhancementMessage" class="referenceHint" role="status">{{ enhancementMessage }}</p>
        </div>
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting"
            placeholder="搜索模型名称或 ID"
            aria-label="生成模型"
            noDataText="请从画布菜单的“模型接入”配置视频平台和模型"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label === item.modelId ? item.label : `${item.label} · ${item.modelId}`"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:duration="data.duration"
            v-model:resolution="data.resolution"
            v-model:ratio="data.ratio"
            v-model:mode="data.mode"
            v-model:generateAudio="data.generateAudio"
            :ratios="ratioOptions"
            :model="selectedModel"
            :availableModes="matchingModes"
            :disabled="generating || deleting || !selectedModel" />
          <div class="generationActions">
            <mediaPrice v-if="generationInput" :input="{ ...generationInput, mediaType: 'video' }" :supported="selectedModel?.supportsPrice === true" />
            <el-button
              class="sendButton"
              :icon="generating ? IconPlayerStop : IconArrowUp"
              :disabled="deleting || uploading || (!generating && (!generationPrompt || !!generationDisabledReason))"
              :title="generating ? '停止生成' : '生成视频'"
              :aria-label="generating ? '停止生成' : '生成视频'"
              @click="generating ? generationController?.abort() : startGeneration().catch((error) => showNodeError(error, '视频生成失败'))" />
          </div>
        </div>
        <p v-if="generationDisabledReason" class="referenceHint" role="status">{{ generationDisabledReason }}</p>
        <el-button text :disabled="generating || deleting || uploading" @click="recoverGeneration">核对并恢复</el-button>
        <p v-if="recoveryMessage" class="referenceHint" role="status">{{ recoveryMessage }}</p>
      </el-card>
    </template>
  </nodeSkeleton>
  <videoActions ref="actions" :file="outputFile" :src="previewUrl" :disabled="generating || deleting || uploading" />
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElDropdown, ElDropdownMenu, ElDropdownItem } from "element-plus";
import { IconCameraAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer, IconMusic, IconLayersSubtract, IconScissors, IconPhotoScan, IconPlayerSkipBack, IconPlayerSkipForward } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeMediaModel, type NodeVideoRequest, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { enhanceVideoPrompt, recordPromptAction } from "@toonflow/node-shared/videoPromptAssistant";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import promptInput from "@toonflow/node-shared/promptInput";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import videoActions from "@toonflow/node-video/videoActions";
import referenceItem from "@toonflow/node-shared/referenceItem";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import mediaPrice from "@toonflow/node-shared/mediaPrice";
import generationSettings from "./components/generationSettings.vue";

defineOptions({
  inheritAttrs: false,
  icon: IconCameraAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "视频生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; duration?: number; resolution: string; ratio: string; mode: string; generateAudio: boolean });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.resolution ??= "";
data.value.mode ??= "";
data.value.generateAudio ??= true;
data.value.ratio ??= "9:16";
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
let disposed = false;
const deleting = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const actions = ref<InstanceType<typeof videoActions>>();
const videoWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort());
const { generating } = generationState;
const recoveryMessage = ref("");
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
// ACT: 供应商未声明视频比例范围，沿用界面的通用比例，具体支持范围由供应商校验。
const ratioOptions = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const selectedMode = computed(() => selectedModel.value?.mode?.find((item) => JSON.stringify(item) === data.value.mode) as NodeVideoRequest["mode"]);
const frameMode = computed(() => ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(selectedMode.value)));
const mediaCounts = computed(() => ({
  image: refList.value.filter((item) => item.dataType === "IMAGE").length,
  video: refList.value.filter((item) => item.dataType === "VIDEO").length,
  audio: refList.value.filter((item) => item.dataType === "AUDIO").length,
}));
const matchingModes = computed(() => getMatchingModes(selectedModel.value));

const getWorkspaceDirectory = inject<(() => string) | undefined>("workspaceDirectory", undefined);
function currentWorkspaceDirectory() {
  try { return getWorkspaceDirectory?.() ?? ""; } catch { return ""; }
}
const enhancingPrompt = ref(false);
const enhancementMessage = ref("");
const originalPrompt = ref<{ prompt: string; promptModel: PromptModel }>();
let assistanceId: string | undefined;
function logPromptAction(action: "promptApplied" | "promptRestored") {
  void recordPromptAction({ directory: currentWorkspaceDirectory(), action, prompt: data.value.prompt, assistanceId })
    .catch(error => { if (!disposed) enhancementMessage.value = error.message; });
}
let enhancementController: AbortController | undefined;
const enhancementDisabledReason = computed(() => {
  if (refList.value.some(item => item.dataType === "AUDIO")) return "提示词完善暂不支持音频引用，请移除音频引用或直接生成。";
  if (refList.value.some(item => item.value === undefined)) return "引用节点暂无内容，请先补充引用内容。";
  if (refList.value.some(item => !["STRING", "IMAGE", "VIDEO"].includes(String(item.dataType)))) return "提示词完善仅支持文字、图片和视频引用。";
  if ([...(data.value.prompt.match(/\{\{ref\s+\d+\}\}/g) ?? [])].some(token => {
    const index = Number(token.match(/\d+/)![0]);
    return index < 1 || index > refList.value.length;
  })) return "提示词引用编号不存在，请重新插入引用。";
  if (data.value.promptModel.some(line => line.some(tag => {
    if (tag.type === "Write") return false;
    if (tag.type !== "Custom") return true;
    const template = document.createElement("template");
    template.innerHTML = tag.html;
    const elements = template.content.querySelectorAll<HTMLElement>(".imageReference[data-reference-id][data-value]");
    if (elements.length !== 1) return true;
    const element = elements[0];
    const reference = referenceMentions.value.find(item => item.id === element.dataset.referenceId && item.value === element.dataset.value);
    if (!reference || element.textContent !== reference.name || [...element.children].some(child => child.tagName !== "IMG")) return true;
    element.remove();
    return !!template.content.textContent || [...template.content.querySelectorAll("*")].some(element => element.tagName !== "SPAN" || [...element.attributes].some(attribute => attribute.name !== "style"));
  }))) return "提示词含有其他富文本标签，请编辑为文字和素材引用后再完善。";
  if (!selectedMode.value || !matchingModes.value.some(mode => JSON.stringify(mode) === JSON.stringify(selectedMode.value))) return "引用素材与当前视频模式不匹配，请调整模式或引用。";
  if (!currentWorkspaceDirectory()) return "请先选择项目。";
  if (!selectedModel.value) return "请先选择视频模型。";
  if (!data.value.prompt.trim()) return "请输入提示词。";
  if (data.value.prompt.length > 10000) return "提示词完善最多支持10000字，请精简内容后再试。";
  if (generating.value || deleting.value || uploading.value) return "请等待当前操作完成。";
  return "";
});
const enhancementContext = computed(() => JSON.stringify([
  id, currentWorkspaceDirectory(), data.value.model, data.value.mode,
  data.value.duration, data.value.resolution, data.value.ratio, data.value.generateAudio,
  selectedModel.value, refList.value,
]));
const enhancementSnapshot = computed(() => JSON.stringify([
  enhancementContext.value, data.value.prompt, data.value.promptModel,
]));
function cancelPromptEnhancement() {
  enhancementController?.abort();
  enhancementController = undefined;
  enhancingPrompt.value = false;
}
watch(enhancementSnapshot, () => {
  cancelPromptEnhancement();
  enhancementMessage.value = "";
}, { flush: "sync" });
watch(enhancementContext, () => { originalPrompt.value = undefined; }, { flush: "sync" });
function setPrompt(value: string, promptModel?: PromptModel) {
  data.value.prompt = value;
  data.value.promptModel = promptModel ?? value.split("\n").map((text) => [{ type: "Write", text }]);
}
function restorePrompt() {
  if (!originalPrompt.value || generating.value || deleting.value || enhancingPrompt.value) return;
  const original = originalPrompt.value;
  setPrompt(original.prompt, JSON.parse(JSON.stringify(original.promptModel)));
  logPromptAction("promptRestored");
  enhancementMessage.value = "已恢复原文，可继续编辑或直接生成。";
}
async function improvePrompt() {
  if (enhancementDisabledReason.value || enhancingPrompt.value || disposed) return;
  const choice = selectedModel.value!;
  const snapshot = enhancementSnapshot.value;
  const original = { prompt: data.value.prompt, promptModel: JSON.parse(JSON.stringify(data.value.promptModel)) as PromptModel };
  const controller = new AbortController();
  enhancementController = controller;
  enhancingPrompt.value = true;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    if (enhancementController === controller) {
      enhancementController = undefined;
      enhancingPrompt.value = false;
      enhancementMessage.value = "提示词完善超时，请重试或直接生成。";
    }
  }, 40000);
  enhancementMessage.value = "";
  try {
    const result = await enhanceVideoPrompt({
      directory: currentWorkspaceDirectory(), providerId: choice.providerId, modelId: choice.modelId,
      prompt: original.prompt, mode: selectedMode.value, duration: data.value.duration,
      references: refList.value.map(item => {
        if (item.dataType === "STRING" && typeof item.value === "string") return { dataType: "STRING", value: item.value };
        if ((item.dataType === "IMAGE" || item.dataType === "VIDEO") && item.value) return { dataType: item.dataType, value: { url: item.value.url, mimeType: item.value.mimeType } };
        throw new Error("引用素材不可用，请检查引用内容。");
      }),
      resolution: data.value.resolution || undefined, ratio: data.value.ratio,
      generateAudio: choice.audio === true || (choice.audio === "optional" && data.value.generateAudio === true),
    }, controller.signal);
    if (controller.signal.aborted || disposed || deleting.value || generating.value || snapshot !== enhancementSnapshot.value) return;
    if (result.status === "clarification") {
      enhancementMessage.value = [result.clarification ?? "请确认原文后重试，也可直接生成。", result.activityWarning].filter(Boolean).join(" ");
      return;
    }
    originalPrompt.value ??= original;
    assistanceId = result.assistanceId;
    setPrompt(result.enhancedPrompt);
    logPromptAction("promptApplied");
    enhancementMessage.value = [result.changeSummary, result.activityWarning].filter(Boolean).join(" ");
  } catch (error) {
    if (!timedOut && !controller.signal.aborted && !disposed && snapshot === enhancementSnapshot.value) {
      enhancementMessage.value = error instanceof Error ? error.message : "提示词完善失败，可直接使用原文生成。";
    }
  } finally {
    clearTimeout(timeout);
    if (enhancementController === controller) {
      enhancementController = undefined;
      enhancingPrompt.value = false;
    }
  }
}

function getMatchingModes(choice?: NodeMediaModel) {
  return (choice?.mode ?? []).filter((mode) => {
    const { image, video, audio } = mediaCounts.value;
    if (Array.isArray(mode)) return image + video + audio > 0 && Object.entries(mediaCounts.value).every(([type, count]) =>
      count <= Number(mode.find((item) => item.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0)
    );
    if (mode === "text") return image + video + audio === 0;
    if (video || audio) return false;
    if (mode === "singleImage") return image === 1;
    if (mode === "startEndRequired") return image === 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && image >= 1 && image <= 2;
  });
}

function getDurations(choice: NodeMediaModel) {
  return [...new Set((choice.durationResolutionMap ?? []).flatMap((item) => item.duration))].sort((a, b) => a - b);
}

function getResolutions(choice: NodeMediaModel, duration?: number) {
  // ACT: 当前视频分辨率使用 p 单位；出现其他单位时再统一换算。
  return [...new Set((choice.durationResolutionMap ?? []).filter((item) => item.duration.includes(duration!)).flatMap((item) => item.resolution))]
    .sort((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity));
}
const generationDisabledReason = computed(() => {
  const choice = selectedModel.value;
  if (!choice) return "请先选择视频模型。";
  if (!choice.mode?.length) return "该模型的生成模式尚未确认，请在模型接入中核实配置。";
  if (choice.audio !== true && choice.audio !== false && choice.audio !== "optional") return "该模型的音频能力尚未确认，请在模型接入中核实配置。";
  if (!getDurations(choice).length) return "该模型的时长与分辨率能力尚未确认，请先核实配置。";
  if (!selectedMode.value || !matchingModes.value.some(mode => JSON.stringify(mode) === data.value.mode)) return "当前素材与模型模式不匹配，请调整引用或更换模型。";
  if (refList.value.some(item => item.value === undefined)) return "引用素材暂无内容，请先补充素材。";
  if (!getDurations(choice).includes(data.value.duration!) || !getResolutions(choice, data.value.duration).includes(data.value.resolution)) return "请选择该模型支持的时长与分辨率组合。";
  if (choice.audio === "optional" && typeof data.value.generateAudio !== "boolean") return "请选择是否生成音频。";
  return "";
});
// ACT: 引用改变时只替换不适用的模式；普通媒体优先作为参考，避免自动变成首尾帧。
watch([selectedModel, matchingModes, () => data.value.mode], ([choice, matches]) => {
  if (!choice || matches.some((item) => JSON.stringify(item) === data.value.mode)) return;
  const mode = matches.find(Array.isArray) ?? matches.find((item) => item === "singleImage")
    ?? matches.find((item) => item === "endFrameOptional") ?? matches[0];
  data.value.mode = mode === undefined ? "" : JSON.stringify(mode);
}, { flush: "sync" });
// ACT: 参数在节点内归一化，未选中、未挂载底部设置时也可由 Agent 直接生成。
watch([selectedModel, () => data.value.duration], ([choice]) => {
  if (!choice) return;
  const durations = getDurations(choice);
  if (!durations.includes(data.value.duration!)) data.value.duration = durations[0];
  const resolutions = getResolutions(choice, data.value.duration);
  if (!resolutions.includes(data.value.resolution)) data.value.resolution = resolutions[0] ?? "";
  if (!ratioOptions.includes(data.value.ratio)) data.value.ratio = "9:16";
  if (typeof choice.audio === "boolean") data.value.generateAudio = choice.audio;
}, { flush: "sync" });
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() =>
  [
    data.value.prompt.trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const generationInput = computed<Omit<NodeVideoRequest, "directory"> | undefined>(() => {
  const choice = selectedModel.value;
  if (!choice || generationDisabledReason.value) return;
  const images = refList.value.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  return {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    mode: selectedMode.value,
    duration: data.value.duration,
    resolution: data.value.resolution || undefined,
    ratio: data.value.ratio,
    generateAudio: choice.audio === "optional" ? data.value.generateAudio : choice.audio,
    outputDirectory: `assets/${id}`,
    images: frameMode.value ? undefined : images,
    firstFrame: frameMode.value && (selectedMode.value !== "startFrameOptional" || images.length > 1) ? images[0] : undefined,
    lastFrame: frameMode.value ? images[selectedMode.value === "startFrameOptional" && images.length === 1 ? 0 : 1] : undefined,
    videos: refList.value.flatMap(item => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    audios: refList.value.flatMap(item => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
  };
});
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, "视频读取失败")
);

onMounted(() => {
  window.addEventListener("toonflow:plugin-installed", refreshProviderModels);
  window.addEventListener("toonflow:provider-config-changed", refreshProviderModels);
  void loadModels().catch(error => { if (!disposed) showNodeError(error, "模型读取失败"); });
});
onScopeDispose(() => {
  disposed = true;
  cancelPromptEnhancement();
  window.removeEventListener("toonflow:plugin-installed", refreshProviderModels);
  window.removeEventListener("toonflow:provider-config-changed", refreshProviderModels);
  generationController?.abort();
});

async function refreshProviderModels(event: Event) {
  if (event.type === "toonflow:plugin-installed" && (event as CustomEvent<{ type?: string }>).detail?.type !== "provider") return;
  try {
    await generation;
    if (!disposed && !deleting.value) await loadModels();
  } catch (error) {
    if (!disposed) showNodeError(error, "模型读取失败");
  }
}

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || disposed) return;
  if (!file.type.startsWith("video/")) return void showNodeError("请选择视频文件", "视频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("视频不能为空且不能超过 100 MB", "视频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 保留历史输出文件，避免破坏撤销记录和复制节点的引用。
    outputs.value.video = { dataType: "VIDEO", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "视频替换失败");
  } finally {
    uploading.value = false;
  }
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (disposed || generating.value || deleting.value) return;
    models.value = items.filter((item) => item.type === "video");
    // ACT: 只给空配置选默认模型，保留暂时不可用的旧选择及其参数。
    if (!data.value.model) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function recoverGeneration() {
  if (generating.value || uploading.value || deleting.value) return;
  cancelPromptEnhancement();
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  generationController = controller;
  recoveryMessage.value = "正在核对原任务，不会重新生成。";
  generation = generationState.run(async () => {
    const { directory } = await workspace.list("", AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
    const result = await ai.recoverMedia(directory, controller.signal);
    controller.signal.throwIfAborted();
    if (result.state === "succeeded") {
      const file = result.files[0];
      if (!file || file.mediaType !== "video") throw new Error("原任务不是视频，请到任务中心查看结果");
      outputs.value.video = { dataType: "VIDEO", value: { url: file.path, mimeType: file.mimeType } };
      recoveryMessage.value = "原视频已恢复，没有重新生成。";
    } else {
      recoveryMessage.value = result.state === "closed" ? "已确认原请求未生成，可以重新提交。" : "当前节点没有待核对任务。";
    }
    return result;
  }, result => result.state === "succeeded")
    .then(() => {})
    .catch(error => {
      recoveryMessage.value = controller.signal.aborted ? "已停止核对，原任务提醒保留。" : error instanceof Error ? error.message : "核对失败，请稍后重试。";
    })
    .finally(() => { generationController = undefined; });
  await generation;
}

async function startGeneration() {
  cancelPromptEnhancement();
  const choice = selectedModel.value;
  const input = generationInput.value;
  if (generating.value) throw new Error("视频正在生成，请等待完成");
  if (uploading.value) throw new Error("视频正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (generationDisabledReason.value) throw new Error(generationDisabledReason.value);
  if (!choice || !input) throw new Error("请先选择视频模型");
  if (!generationPrompt.value) throw new Error("请输入生成提示词");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  recoveryMessage.value = "";
  if (choice.mode?.length && !matchingModes.value.length) throw new Error("当前模型没有适合这些参考素材的生成模式，请更换模型或调整引用");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  generationController = controller;
  // ACT: 工具立即返回，任务由节点持有，停止或卸载时取消。
  generation = generationState.run(() => workspace
    .list("", AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]))
    .then(({ directory }) => {
      controller.signal.throwIfAborted();
      return ai.generateVideo({ ...input, directory }, controller.signal);
    })
    .then(([result]) => {
      controller.signal.throwIfAborted();
      if (!result) throw new Error("供应商未返回视频");
      outputs.value.video = { dataType: "VIDEO", value: { url: result.path, mimeType: result.mimeType } };
    }))
    .catch((error) => showNodeError(error, "视频生成失败"))
    .finally(() => {
      generationController = undefined;
    });
  return { status: "generating" };
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value)) throw new Error("视频处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("视频正在替换，请稍后删除节点");
  deleting.value = true;
  cancelPromptEnhancement();
  generationController?.abort();
  try {
    await generation;
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, (240 * video.videoWidth) / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      duration: data.value.duration,
      resolution: data.value.resolution,
      ratio: data.value.ratio,
      mode: selectedMode.value,
      generateAudio: data.value.generateAudio,
    },
    models: models.value,
    ratios: ratioOptions,
    matchingModes: matchingModes.value,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此视频生成节点的当前配置、可选视频模型能力、通用比例及适合当前引用的模式，不含密钥；时长与分辨率须符合 durationResolutionMap",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此视频生成节点的模型、时长、分辨率、比例、模式或声音；先用 getConfig 查询能力，providerId 与 modelId 必须同时提供；mode 使用返回的原始字符串或数组，须匹配当前引用；不修改提示词、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    duration: z.number().positive().optional(),
    resolution: z.string().min(1).optional(),
    ratio: z.enum(ratioOptions).optional(),
    mode: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    generateAudio: z.boolean().optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效视频模型");
    const durations = getDurations(choice);
    if (args.duration !== undefined && !durations.includes(args.duration)) throw new Error(`当前模型不支持时长 ${args.duration}，可选：${durations.join("、")}`);
    const duration = args.duration ?? (durations.includes(data.value.duration!) ? data.value.duration : durations[0]);
    const resolutions = getResolutions(choice, duration);
    if (args.resolution !== undefined && !resolutions.includes(args.resolution)) throw new Error(`当前时长不支持分辨率 ${args.resolution}，可选：${resolutions.join("、")}`);
    const resolution = args.resolution ?? (resolutions.includes(data.value.resolution) ? data.value.resolution : resolutions[0] ?? "");
    if (args.mode !== undefined && !getMatchingModes(choice).some((item) => JSON.stringify(item) === JSON.stringify(args.mode))) throw new Error("所选模式不受当前模型支持或不适用于当前引用，请根据模型能力及已连接素材选择");
    if (args.generateAudio !== undefined && choice.audio !== "optional" && args.generateAudio !== (choice.audio === true)) throw new Error("当前模型不支持切换声音，请查看 getConfig 返回的 audio 能力");
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    data.value.duration = duration;
    data.value.resolution = resolution;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    if (args.mode !== undefined) data.value.mode = JSON.stringify(args.mode);
    if (args.generateAudio !== undefined) data.value.generateAudio = args.generateAudio;
    return getConfig();
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的视频生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    setPrompt(value);
    return { prompt: value };
  },
});

nodeTools.register({
  name: "generateVideo",
  description: "启动此节点的后台视频生成，使用当前提示词、模型、模式、时长、分辨率、比例和参考素材；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 停止生成",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.videoContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .videoEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.promptCard {
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .generationActions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;

      .sendButton {
        width: 32px;
        height: 32px;
        margin-left: 0;
        padding: 0;
        --el-button-bg-color: var(--el-text-color-primary);
        --el-button-border-color: transparent;
        --el-button-text-color: var(--el-bg-color);
        --el-button-hover-bg-color: var(--el-text-color-regular);
        --el-button-hover-border-color: transparent;
        --el-button-hover-text-color: var(--el-bg-color);
      }
    }
  }
}
</style>
