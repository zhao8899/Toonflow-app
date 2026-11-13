<template>
  <div class="home">
    <bg class="pageBackground" />
    <aside class="sideNav" aria-label="侧边导航">
      <div class="sideBrand">
        <span>DCtiv</span>
      </div>
      <nav class="sideLinks">
        <button type="button" class="sideLink" :class="{ active: activeSection === 'create' }" :aria-current="activeSection === 'create' ? 'page' : undefined" @click="selectSection('create')">
          <icon-home :size="18" aria-hidden="true" />首页
        </button>
        <button type="button" class="sideLink" :class="{ active: activeSection === 'projects' }" :aria-current="activeSection === 'projects' ? 'page' : undefined" @click="selectSection('projects')">
          <icon-folders :size="18" aria-hidden="true" />项目
        </button>
      </nav>
      <div class="sideFooter">
        <el-button text class="sideButton" :icon="IconSettings" @click="openModelSettings">模型接入</el-button>
        <el-badge isDot :hidden="!hasDesktopUpdate">
          <el-button text class="sideButton" :icon="IconSettings" :aria-label="hasDesktopUpdate ? '设置，有新版本可用' : '设置'" @click="settingsPanel = undefined; settingsVisible = true">设置</el-button>
        </el-badge>
        <el-button v-if="!authRequired" text class="sideButton" :type="deviceHubEnabled ? 'success' : undefined" :icon="deviceHubEnabled || mobileConnection.mode === 'remote' ? IconDeviceDesktop : IconQrcode" @click="mobileConnectVisible = true">{{ mobileConnectionLabel }}</el-button>
      </div>
    </aside>
    <el-container class="mainArea">
    <el-header class="pageHeader">
      <div class="headerActions">
        <sessionMenu />
        <el-button class="compactAction" text @click="openModelSettings">模型接入</el-button>
        <!-- 窄屏隐藏侧边栏时，设置入口回到顶部 -->
        <el-badge class="compactAction" isDot :hidden="!hasDesktopUpdate">
          <el-button circle :icon="IconSettings" :aria-label="hasDesktopUpdate ? '设置，有新版本可用' : '设置'" @click="settingsPanel = undefined; settingsVisible = true" />
        </el-badge>
        <el-button v-if="!authRequired" class="compactAction" circle :icon="deviceHubEnabled || mobileConnection.mode === 'remote' ? IconDeviceDesktop : IconQrcode" :aria-label="mobileConnectionLabel" @click="mobileConnectVisible = true" />
      </div>
    </el-header>
    <el-main class="pageContent">
      <section v-show="activeSection === 'create'" class="creationPanel" aria-label="创建项目">
        <div class="hero">
          <div>
            <h1>开始创作</h1>
            <p>AI 短剧、漫剧与视频创作</p>
          </div>
          <el-button type="primary" :icon="IconFolderPlus" :disabled="creating || opening" @click="createProject(false)">新建项目</el-button>
        </div>
        <div class="creationTools" role="group" aria-label="快捷创作">
          <button v-for="tool in quickTools" :key="tool.label" type="button" class="creationTool" :disabled="creating || opening" @click="useQuickTool(tool.prompt)">
            <component :is="tool.icon" :size="24" aria-hidden="true" />
            <span>{{ tool.label }}</span>
          </button>
        </div>
        <div class="promptArea">
          <h2 class="composerTitle">描述你的创意</h2>
          <el-card class="promptCard" :class="{ draggingAttachments }" shadow="never" :bodyStyle="{ padding: '20px' }" :footerStyle="{ padding: '12px 16px' }" @dragenter.capture="dragEnterAttachments" @dragover.capture="dragOverAttachments" @dragleave.capture="dragLeaveAttachments" @drop.capture="dropAttachments">
            <div v-if="draggingAttachments" class="attachmentDropOverlay" role="status" aria-live="polite">
              <icon-paperclip :size="20" aria-hidden="true" />
              <strong>松开添加附件</strong>
              <span>图片、视频、文档或代码文件</span>
            </div>
            <input ref="attachmentInput" type="file" :accept="attachmentAccept" multiple hidden :disabled="creating || opening" @change="selectAttachments" />
            <attachmentList v-if="promptAttachments.length" class="promptAttachments" :attachments="promptAttachments" removable restorable :disabled="creating || opening" @remove="promptAttachments.splice($event, 1)" @restore="restoreAttachment" />
            <el-input ref="promptInput" v-model="prompt" type="textarea" :rows="4" resize="none" :disabled="creating || opening" :placeholder="promptPlaceholder" aria-label="创作描述" @paste.capture="pasteAttachments" />
            <template #footer>
              <div class="composerFooter">
                <workspacePicker ref="promptWorkspacePicker" v-model="workspaceDirectory" :disabled="creating || opening" />
                <el-space class="sendActions" wrap :size="12">
                  <el-button text circle :icon="IconPaperclip" :disabled="creating || opening" aria-label="添加附件" title="添加附件" @click="attachmentInput?.click()" />
                  <modelPopover v-model="selectedModel" v-model:reasoningEffort="reasoningEffort" class="modelSelect" :disabled="creating || opening" />
                  <el-button class="sendButton" type="primary" :circle="!!workspaceDirectory" :icon="workspaceDirectory ? IconArrowUp : IconFolder" :loading="creating" :disabled="creating || opening" :aria-label="workspaceDirectory ? '发送' : '选择工作目录'" @click="workspaceDirectory ? createProject() : promptWorkspacePicker?.chooseDirectory()">
                    <template v-if="!workspaceDirectory" #default>选择工作目录</template>
                  </el-button>
                </el-space>
              </div>
              <p v-if="!workspaceDirectory" class="workspaceHint" role="status">请先选择一个空文件夹作为工作目录，画布和素材会保存在这里。</p>
            </template>
          </el-card>
        </div>
      </section>
      <section v-show="activeSection === 'projects' || projectList.length" class="projectList" aria-labelledby="projectListTitle">
        <div class="sectionHeader">
          <h2 id="projectListTitle">{{ activeSection === 'projects' ? '我的项目' : '最近打开' }} <span v-if="activeSection === 'projects'" class="projectCount">{{ projectList.length }}</span></h2>
          <el-button v-if="activeSection === 'create'" text @click="selectSection('projects')">查看全部项目</el-button>
          <el-space v-else wrap>
            <serverProjects v-if="authRequired" :disabled="creating || opening" @open="openServerProject" />
            <el-button :icon="IconFolderOpen" :disabled="creating || opening" @click="openProject()">导入项目</el-button>
            <el-button type="primary" :icon="IconFolderPlus" :disabled="creating || opening" @click="createProject(false)">新建项目</el-button>
          </el-space>
        </div>
        <div v-if="activeSection === 'projects'" class="projectToolbar">
          <el-input v-model="projectSearch" class="projectSearch" clearable :prefixIcon="IconSearch" placeholder="搜索项目名称或目录" aria-label="搜索项目" />
          <el-space wrap>
            <el-button circle :icon="sortDescending ? IconSortDescending : IconSortAscending" :aria-label="sortDescending ? '按时间降序' : '按时间升序'" @click="sortDescending = !sortDescending" />
            <el-radio-group v-model="viewMode" aria-label="项目视图">
              <el-radio-button value="grid" aria-label="网格视图"><icon-layout-grid :size="16" /></el-radio-button>
              <el-radio-button value="list" aria-label="列表视图"><icon-list :size="16" /></el-radio-button>
            </el-radio-group>
          </el-space>
        </div>
        <div class="projectItems" :class="{ listView: activeSection === 'projects' && viewMode === 'list' }">
          <el-card v-for="project in visibleProjects" :key="project.directory" class="projectCard" shadow="hover" :bodyStyle="{ padding: '0' }">
            <button class="projectEntry" type="button" :disabled="creating || opening" :aria-label="`打开项目 ${project.name}`" @click="openProject(project)">
              <icon-folder class="projectIcon" :size="28" aria-hidden="true" />
              <span class="projectInfo">
                <span class="projectName" :title="project.name">{{ project.name }}</span>
                <span class="projectPath" :title="project.directory">{{ project.directory }}</span>
                <span class="projectTime">最近打开 {{ new Date(project.lastOpenedAt).toLocaleString(locale, { hour12: false }) }}</span>
              </span>
            </button>
            <div v-if="activeSection === 'projects'" class="projectActions">
              <el-button text :icon="IconEdit" :disabled="creating || opening" :aria-label="`重命名项目 ${project.name}`" title="重命名" @click="renameProject(project)" />
              <el-button text type="danger" :icon="IconFolderMinus" :disabled="creating || opening" :aria-label="`移除项目 ${project.name}`" title="从列表移除，不删除文件" @click="workspaceStore.removeProject(project.directory)" />
            </div>
          </el-card>
        </div>
      </section>
    </el-main>
    </el-container>
    <settings v-model="settingsVisible" :initialPanel="settingsPanel" />
    <mobileConnect v-model="mobileConnectVisible" />
    <workspacePicker ref="relocationPicker" hideTrigger />
  </div>
</template>

<script setup lang="ts">
import { locale, translate } from "@toonflow/i18n/vue";
import axios from "axios";
import { storeToRefs } from "pinia";
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox, type InputInstance } from "element-plus";
import { getReadableFileMimeType, readableFileAccept } from "@toonflow/server/documentFormats";
import {
  IconSettings, IconQrcode, IconDeviceDesktop,
  IconArrowUp, IconLayoutGrid, IconSearch,
  IconList, IconSortDescending,
  IconSortAscending, IconFolder, IconEdit,
  IconFolderMinus, IconFolderPlus, IconFolderOpen, IconPaperclip,
  IconHome, IconFolders, IconMovie, IconPhoto, IconMusic, IconScript,
} from "@tabler/icons-vue";
import modelPopover from "@/components/modelPopover.vue";
import attachmentList from "@/components/agent/attachmentList.vue";
import { createPastedTextFile, readTextAttachment } from "@/components/agent/textAttachments";
import type { AgentAttachment } from "@/components/agent/types";

import { useWorkspaceStore, type Project } from "@/stores/workspace";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import { deviceHubEnabled, mobileConnection, mobileConnectionLabel } from "@/lib/mobile";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import settings from "@/components/settings/index.vue";
import sessionMenu from "@/components/sessionMenu.vue";
import { authRequired } from "@/lib/auth";
import bg from "./bg.vue";
import workspacePicker from "./workspacePicker.vue";
import serverProjects from "./serverProjects.vue";

const settingsVisible = ref(false);
const settingsPanel = ref<"languageModel" | "mediaModel">();
function openModelSettings() {
  settingsPanel.value = "mediaModel";
  settingsVisible.value = true;
}
const mobileConnectVisible = ref(false);
const mobileConnect = defineAsyncComponent(() => import("@/components/mobileConnect.vue"));
const router = useRouter();
const creating = ref(false);
const opening = ref(false);
const promptWorkspacePicker = ref<InstanceType<typeof workspacePicker>>();
const relocationPicker = ref<InstanceType<typeof workspacePicker>>();
const prompt = ref("");
const promptInput = ref<InputInstance>();
const promptAttachments = ref<AgentAttachment[]>([]);
const attachmentInput = ref<HTMLInputElement>();
const attachmentAccept = `image/*,video/*,${readableFileAccept}`;
const draggingAttachments = ref(false);
let attachmentDragDepth = 0;
const workspaceStore = useWorkspaceStore();
const { project, projectList } = storeToRefs(workspaceStore);
const workspaceDirectory = ref(project.value?.directory ?? "");
const placeholderPhrases = [
  "描述你想创作的内容，让灵感从这里开始…",
  "把一个故事灵感，变成一段精彩的短片…",
  "为你的主角设计独特的外形和性格…",
  "创作一段雨夜街头的电影感镜头…",
  "把这段文字拆解成连贯的分镜画面…",
  "为一场奇幻冒险生成场景和角色…",
  "为你的画面配上一段合适的音乐…",
  "写一段温暖的旁白，讲述这个故事…",
  "设计一支富有想象力的产品宣传片…",
  "从一句话开始，搭建你的创作工作流…",
];
const promptPlaceholder = ref(translate(placeholderPhrases[0]!));

onMounted(() => {
  window.addEventListener("dragend", clearAttachmentDrag, true);
  window.addEventListener("drop", clearAttachmentDrag, true);
  window.addEventListener("blur", clearAttachmentDrag);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let phraseIndex = 0;
  watch([() => !!prompt.value, locale], ([hasInput], _previous, onCleanup) => {
    if (reduceMotion) {
      promptPlaceholder.value = translate(placeholderPhrases[0]!);
      return;
    }
    if (hasInput) return;
    const segmenter = new Intl.Segmenter(locale.value, { granularity: "grapheme" });
    const phrases = placeholderPhrases.map(phrase => [...segmenter.segment(translate(phrase))].map(part => part.segment));
    let characterCount = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;
    promptPlaceholder.value = "";

    function typePlaceholder() {
      const phrase = phrases[phraseIndex]!;
      characterCount += deleting ? -1 : 1;
      promptPlaceholder.value = phrase.slice(0, characterCount).join("");
      let delay = deleting ? 35 : 85;
      if (characterCount === phrase.length) {
        deleting = true;
        delay = 1800;
      } else if (characterCount === 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % placeholderPhrases.length;
        delay = 300;
      }
      timer = setTimeout(typePlaceholder, delay);
    }

    timer = setTimeout(typePlaceholder, 300);
    onCleanup(() => clearTimeout(timer));
  }, { immediate: true });
});

onUnmounted(() => {
  window.removeEventListener("dragend", clearAttachmentDrag, true);
  window.removeEventListener("drop", clearAttachmentDrag, true);
  window.removeEventListener("blur", clearAttachmentDrag);
});
watch([creating, opening], ([creating, opening]) => {
  if (creating || opening) clearAttachmentDrag();
}, { flush: "sync" });

const route = useRoute();
const activeSection = computed(() => route.query.view === "projects" ? "projects" : "create");
const quickTools = [
  { label: "视频生成", icon: IconMovie, prompt: "生成一段视频：" },
  { label: "图片生成", icon: IconPhoto, prompt: "生成一张图片：" },
  { label: "音频生成", icon: IconMusic, prompt: "生成一段音频：" },
  { label: "剧本生成", icon: IconScript, prompt: "根据以下故事创作剧本：" },
];

function selectSection(section: "create" | "projects") {
  void router.push({ query: { ...route.query, view: section === "projects" ? "projects" : undefined } });
}

// 快捷标签只在输入框开头补充任务说明，保留已输入内容，仍由用户确认后发送。
async function useQuickTool(text: string) {
  const starter = translate(text);
  if (!prompt.value.startsWith(starter)) prompt.value = `${starter}${prompt.value}`;
  await nextTick();
  promptInput.value?.focus();
  promptInput.value?.textarea?.setSelectionRange(prompt.value.length, prompt.value.length);
}

const selectedModel = ref("");
const reasoningEffort = ref("");
const sortDescending = ref(true);
const viewMode = ref("grid");
const projectSearch = ref("");
const sortedProjects = computed(() => [...projectList.value].sort((left, right) =>
  sortDescending.value ? right.lastOpenedAt - left.lastOpenedAt : left.lastOpenedAt - right.lastOpenedAt
));
const visibleProjects = computed(() => {
  if (activeSection.value === "create") return [...projectList.value].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt).slice(0, 4);
  const query = projectSearch.value.trim().toLocaleLowerCase();
  return sortedProjects.value.filter(item => `${item.name} ${item.directory}`.toLocaleLowerCase().includes(query));
});

function pasteAttachments(event: ClipboardEvent) {
  if (creating.value || opening.value) return;
  try {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) {
      const file = createPastedTextFile(event.clipboardData?.getData("text/plain") ?? "");
      if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    addAttachments(files);
  } catch (error) {
    event.preventDefault();
    event.stopImmediatePropagation();
    ElMessage.error(error instanceof Error ? error.message : "添加附件失败，请重试");
  }
}

function selectAttachments(event: Event) {
  const input = event.target as HTMLInputElement;
  addAttachments(Array.from(input.files ?? []));
  input.value = "";
}

function clearAttachmentDrag() {
  attachmentDragDepth = 0;
  draggingAttachments.value = false;
}

function dragEnterAttachments(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  if (creating.value || opening.value) return clearAttachmentDrag();
  attachmentDragDepth++;
  draggingAttachments.value = true;
}

function dragOverAttachments(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = creating.value || opening.value ? "none" : "copy";
  if (creating.value || opening.value) return clearAttachmentDrag();
  attachmentDragDepth = Math.max(1, attachmentDragDepth);
  draggingAttachments.value = true;
}

function dragLeaveAttachments(event: DragEvent) {
  if (!draggingAttachments.value) return;
  attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
  const target = event.currentTarget;
  if (!attachmentDragDepth || (target instanceof Node && event.relatedTarget instanceof Node && !target.contains(event.relatedTarget))) clearAttachmentDrag();
}

function dropAttachments(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  clearAttachmentDrag();
  addAttachments(Array.from(event.dataTransfer.files));
}

function addAttachments(files: File[]) {
  if (creating.value || opening.value) return;
  for (const file of files) {
    const readableMimeType = getReadableFileMimeType(file.name, file.type);
    const mimeType = readableMimeType ?? file.type.split(";")[0]!.trim().toLowerCase();
    if (!readableMimeType && !/^(image|video)\//.test(mimeType)) {
      ElMessage.warning("只支持图片、视频和受支持的文本或文档文件");
      continue;
    }
    if (!file.size || file.size > 100 * 1024 * 1024) {
      ElMessage.warning("附件不能为空且不能超过 100 MB");
      continue;
    }
    if (mimeType === "text/plain" && file.size > 400000) {
      ElMessage.warning("文本附件不能超过 400000 字节");
      continue;
    }
    if (promptAttachments.value.length >= 20) {
      ElMessage.warning("每条消息最多添加 20 个附件");
      break;
    }
    promptAttachments.value.push({ name: file.name, path: "", mimeType, file });
  }
}

async function restoreAttachment(index: number) {
  const attachment = promptAttachments.value[index];
  if (attachment?.mimeType !== "text/plain" || creating.value || opening.value) return;
  try {
    const text = await readTextAttachment(attachment);
    const currentIndex = promptAttachments.value.indexOf(attachment);
    if (currentIndex < 0 || creating.value || opening.value) return;
    prompt.value += `${prompt.value ? "\n" : ""}${text}`;
    promptAttachments.value.splice(currentIndex, 1);
    await nextTick();
    promptInput.value?.focus();
    promptInput.value?.textarea?.setSelectionRange(prompt.value.length, prompt.value.length);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "取回文本失败，请重试");
  }
}

async function openServerProject(id: string) {
  if (creating.value || opening.value) return;
  opening.value = true;
  try {
    await workspaceStore.openServerProject(id);
    await router.push("/workspace");
  } catch (error) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.data?.message || "无法打开已登记目录" : "无法打开已登记目录");
  } finally { opening.value = false; }
}

async function openProject(project?: Project) {
  if (project?.serverProjectId) return openServerProject(project.serverProjectId);
  if (creating.value || opening.value) return;
  opening.value = true;
  try {
    const directory = project?.directory ?? await relocationPicker.value?.chooseDirectory();
    if (!directory) return;
    try { await workspaceStore.openProject(directory); }
    catch (err) {
      if (!project || !axios.isAxiosError(err) || err.response?.status !== 404) throw err;
      const reselect = await ElMessageBox.confirm(`项目“${project.name}”的文件夹不存在，是否重新选择文件夹？`, "工作目录不存在", {
        confirmButtonText: "重新选择", cancelButtonText: "取消", type: "warning",
      }).then(() => true, () => false);
      if (!reselect) return;
      const directory = await relocationPicker.value?.chooseDirectory();
      if (!directory) return;
      await workspaceStore.openProject(directory, project.directory);
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "无法打开项目，请重试"
      : err instanceof Error ? err.message : "无法打开项目，请重试");
  } finally { opening.value = false; }
}

async function renameProject(project: Project) {
  const result = await ElMessageBox.prompt("请输入项目名称", "重命名项目", {
    inputValue: project.name, confirmButtonText: "保存", cancelButtonText: "取消",
    inputValidator: value => !!value?.trim() || "项目名称不能为空",
  }).catch(() => null);
  if (result) workspaceStore.renameProject(project.directory, result.value);
}

async function createProject(fromPrompt = true) {
  if (creating.value || opening.value || (fromPrompt && !workspaceDirectory.value)) return;
  creating.value = true;
  try {
    let path = workspaceDirectory.value;
    if (!fromPrompt) {
      const confirmed = await ElMessageBox.confirm("请选择一个空文件夹作为项目目录，画布和素材将保存在其中。", "添加项目", {
        confirmButtonText: "选择空文件夹", cancelButtonText: "取消", type: "info",
      }).then(() => true, () => false);
      if (!confirmed) return;
      path = await relocationPicker.value?.chooseDirectory() ?? "";
      if (!path) return;
    }
    const { directory, empty } = await useWorkspaceFiles(path).list();
    if (!empty) return ElMessage.warning("该文件夹不为空，请重新选择空文件夹；已有项目请使用“导入项目”或点击项目列表打开。");
    await useWorkspaceFiles(directory).writeJson("画布1.json", { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, true);
    await workspaceStore.openProject(directory);
    if (fromPrompt && (prompt.value.trim() || promptAttachments.value.length)) {
      workspaceStore.pendingAgentMessage = { directory: workspaceStore.project!.directory, prompt: prompt.value, attachments: [...promptAttachments.value], model: selectedModel.value, reasoningEffort: reasoningEffort.value };
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "创建项目失败，请重试"
      : err instanceof Error ? err.message : "创建项目失败，请重试");
  } finally {
    creating.value = false;
  }
}
</script>

<style lang="scss" scoped>
.home {
  position: relative;
  isolation: isolate;
  display: flex;
  min-height: 100dvh;
  color: var(--el-text-color-primary);

  .pageBackground {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
  }

  .sideNav {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 32px;
    width: 224px;
    height: 100dvh;
    padding: 28px 16px 20px;
    overflow-y: auto;
    border-inline-end: 1px solid var(--el-border-color-lighter);
    background: var(--el-bg-color);

    .sideBrand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 36px;
      padding: 0 12px;
      flex-shrink: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;

      .brandLogo {
        width: 32px;
        height: 32px;
        flex-shrink: 0;

        .dark & { filter: invert(1); }
      }
    }

    .sideLinks {
      display: flex;
      flex-direction: column;
      gap: 8px;

      .sideLink {
        position: relative;
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 48px;
        padding: 12px 16px;
        border: 0;
        border-radius: var(--ui-radius-large);
        background: transparent;
        color: var(--el-text-color-regular);
        font: inherit;
        font-size: 14px;
        text-align: start;
        white-space: nowrap;
        cursor: pointer;
        transition: background-color 0.15s, color 0.15s;

        svg { flex-shrink: 0; }

        &:hover { background: var(--el-fill-color-light); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }

        &.active {
          background: var(--el-color-primary-light-9);
          color: var(--el-color-primary);
          font-weight: 600;

          &::before {
            content: "";
            position: absolute;
            inset-inline-start: 0;
            top: 16px;
            bottom: 16px;
            width: 3px;
            border-radius: 3px;
            background: var(--el-color-primary);
          }
        }

        @media (prefers-reduced-motion: reduce) { transition: none; }
      }
    }

    .sideFooter {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: auto;
      padding-top: 16px;
      border-top: 1px solid var(--el-border-color-lighter);

      .el-badge { width: 100%; }
      .sideButton {
        width: 100%;
        height: auto;
        min-height: 44px;
        margin: 0;
        padding: 12px 16px;
        justify-content: flex-start;
        border-radius: var(--ui-radius-large);
        white-space: normal;
        text-align: start;
        line-height: 1.5;

        :deep(.el-icon) { font-size: 18px; flex-shrink: 0; }
        :deep(.el-icon + span) { margin-inline-start: 12px; }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
      }
    }

    @media (max-width: 760px) {
      width: 100%;
      height: auto;
      box-sizing: border-box;
      z-index: 1;
      gap: 12px;
      padding: 12px 16px;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      border-inline-end: 0;
      border-bottom: 1px solid var(--el-border-color-lighter);
      .sideBrand { padding: 0; font-size: 18px; }
      .sideLinks {
        flex-direction: row;
        margin-inline-start: auto;
        gap: 4px;
        .sideLink { min-height: 44px; padding: 10px 12px; gap: 8px; }
      }
      .sideFooter { display: none; }
    }

    @media (max-width: 400px) {
      .sideLinks {
        width: 100%;
        .sideLink { justify-content: center; }
      }
    }
  }

  .mainArea {
    flex: 1;
    min-width: 0;
    flex-direction: column;
  }

  @media (max-width: 760px) {
    flex-direction: column;
  }

  .arrowHint {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--el-color-primary);
    font-size: 13px;
    white-space: nowrap;
    pointer-events: none;
    animation: hintNudge 2.4s ease-in-out infinite;

    svg {
      width: 56px;
      height: 30px;
      flex-shrink: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  }

  .pageHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 72px;
    padding: 0 clamp(20px, 4vw, 56px);

    .headerActions {
      display: flex;
      align-items: center;
      gap: 12px;

      .compactAction {
        display: none;

        @media (max-width: 760px) { display: inline-flex; }
      }
    }

    a {
      text-decoration: none;
    }

  }

  .pageContent {
    padding: 24px clamp(20px, 4vw, 56px) 56px;

    .creationPanel {
      max-width: 1040px;
      margin: 0 auto 40px;

      .creationTools {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 16px;
        margin-bottom: 32px;

        .creationTool {
          display: flex;
          align-items: center;
          gap: 12px;
          min-height: 88px;
          padding: 20px;
          border: 1px solid var(--el-border-color-lighter);
          border-radius: var(--ui-radius);
          background: var(--el-bg-color);
          color: var(--el-text-color-primary);
          font: inherit;
          cursor: pointer;
          svg { flex-shrink: 0; color: var(--el-color-primary); }
          &:hover:not(:disabled) { border-color: var(--el-color-primary); background: var(--el-fill-color-light); }
          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
          &:disabled { opacity: 0.6; cursor: wait; }
        }
        @media (max-width: 760px) { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      }

      .hero {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 16px;
        margin-bottom: 24px;

        h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 700;
          letter-spacing: -1px;
          background: var(--ui-accent-gradient);
          background-clip: text;
          color: transparent;
        }

        p {
          margin: 8px 0 0;
          color: var(--el-text-color-secondary);
          font-size: 15px;
        }
      }

      .promptArea {
        position: relative;

        .composerTitle { margin: 0 0 16px; font-size: 18px; font-weight: 600; }

        .inspirationHint {
          bottom: calc(100% + 4px);
          left: 16px;
          height: 30px;
          padding-right: 44px;

          svg {
            position: absolute;
            top: -2px;
            right: 0;
            width: 36px;
            height: 36px;
          }
        }

        .promptCard {
          position: relative;
          border-radius: calc(var(--ui-radius) * 2.5);
          border-color: var(--el-border-color-lighter);
          box-shadow: var(--el-box-shadow-lighter);

          &:focus-within {
            border-color: var(--el-color-primary-light-5);
          }

          &.draggingAttachments {
            border-color: var(--el-color-primary-light-5);
          }

          .attachmentDropOverlay {
            position: absolute;
            inset: 0;
            z-index: 2;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4px;
            border-radius: inherit;
            background: var(--el-bg-color);
            color: var(--el-text-color-primary);
            pointer-events: none;

            > svg { color: var(--el-text-color-secondary); }
            strong { font-size: 14px; font-weight: 500; }
            span { color: var(--el-text-color-secondary); font-size: 12px; }
          }

          .promptAttachments {
            margin-bottom: 12px;
          }

          :deep(.el-textarea__inner) {
            padding: 4px 0;
            box-shadow: none;
            background: transparent;
            font-size: 15px;
            line-height: 1.8;
          }

          :deep(.el-card__footer) {
            background: var(--el-fill-color-extra-light);
          }

          .composerFooter {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;

            .sendActions {
              margin-left: auto;
              justify-content: flex-end;

              .modelSelect {
                width: 190px;
              }

              .sendButton {
                height: 36px;

                &.is-circle { width: 36px; }
              }
            }
          }

          .workspaceHint {
            margin: 12px 0 0;
            color: var(--el-text-color-regular);
            font-size: 13px;
            line-height: 1.6;
          }
        }

        .quickTools {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 10px;
          margin-top: 16px;

          .quickTool {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border: 1px solid var(--el-border-color-lighter);
            border-radius: 999px;
            background: var(--el-bg-color);
            color: var(--el-text-color-regular);
            font: inherit;
            font-size: 13px;
            cursor: pointer;
            transition: border-color 0.2s, color 0.2s;

            &:hover:not(:disabled) { border-color: var(--el-color-primary-light-5); color: var(--el-color-primary); }
            &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
            &:disabled { cursor: not-allowed; opacity: 0.6; }
          }
        }
      }
    }

    .projectList {
      max-width: 1040px;
      margin: 0 auto;

      .projectCount { margin-left: 8px; color: var(--el-text-color-secondary); font-size: 14px; font-weight: 400; }

      .projectToolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 16px;
        margin-top: 20px;
        .projectSearch { width: min(360px, 100%); }
      }

      .projectItems {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
        gap: 16px;
        margin-top: 16px;

        &.listView {
          grid-template-columns: 1fr;
          .projectEntry .projectInfo {
            flex: 1;
            display: grid;
            grid-template-columns: minmax(100px, 1fr) minmax(120px, 2fr) auto;
            align-items: center;
            gap: 16px;
            @media (max-width: 900px) { display: flex; align-items: flex-start; gap: 6px; }
          }
        }

        .projectCard {
          position: relative;

          .projectActions {
            position: absolute;
            top: 12px;
            right: 8px;
            display: flex;
            gap: 4px;

            .el-button { width: 32px; height: 32px; margin: 0; padding: 0; }
          }
        }

        .projectEntry {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          width: 100%;
          padding: 20px 84px 20px 20px;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;

          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
          &:disabled { cursor: wait; opacity: 0.6; }

          .projectIcon { flex-shrink: 0; color: var(--el-text-color-secondary); }

          .projectInfo {
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 0;

            .projectName, .projectPath {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .projectName { font-weight: 600; }
            .projectPath { font-size: 13px; color: var(--el-text-color-regular); }
            .projectTime { font-size: 12px; color: var(--el-text-color-secondary); }
          }
        }
      }

      .sectionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 16px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--el-border-color-lighter);

        h2 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }
      }
    }
  }
}

@keyframes hintNudge {
  0%, 100% { transform: translateX(0) rotate(-3deg); }
  50% { transform: translateX(-6px) rotate(-5deg); }
}
</style>
