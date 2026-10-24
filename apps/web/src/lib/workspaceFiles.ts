import axios from "axios";
import { isMobile, isRemoteConnection } from "./platform";
import { toValue, type MaybeRefOrGetter } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { registerApiLanguage } from "@/lib/i18n";

type WorkspaceEntry = { name: string; path: string; type: "file" | "directory" };
export type TextSnapshot = { text: string; revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" };
const client = axios.create({ baseURL: "/api/workspaces/files", headers: { "x-toonflow-workspace": "1" } });
registerApiLanguage(client);
const fileUrls = new Map<string, { directory: string; path: string; url: Promise<string>; users: number }>();

function cachePath(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/").toLowerCase();
}

function invalidateUrls(directory: string, path: string) {
  // ACT: 仅失效时保守合并路径写法；实际读取仍交服务端校验，区分大小写的文件最多多读一次。
  directory = cachePath(directory);
  path = cachePath(path);
  for (const [key, entry] of fileUrls) {
    const entryPath = cachePath(entry.path);
    if (cachePath(entry.directory) === directory && (entryPath === path || entryPath.startsWith(`${path}/`))) fileUrls.delete(key);
  }
}

export default function useWorkspaceFiles(directory?: MaybeRefOrGetter<string | undefined>, projectId?: MaybeRefOrGetter<string | undefined>) {
  const workspace = directory === undefined ? useWorkspaceStore() : undefined;
  function getContext() {
    const project = workspace?.project;
    const path = directory === undefined ? project?.directory : toValue(directory);
    if (!path) throw new Error("请先选择工作目录");
    const id = directory === undefined ? project?.serverProjectId : toValue(projectId);
    const headers: Record<string, string> = id ? { "x-toonflow-project-id": id } : {};
    return { directory: path, projectId: id, headers };
  }

  async function list(path = "", signal?: AbortSignal) {
    const { directory, headers } = getContext();
    const { data } = await client.get<{ data: { directory: string; empty: boolean; entries: WorkspaceEntry[] } }>("/list", { params: { directory, path }, headers, signal });
    return data.data;
  }

  async function read(path: string) {
    const { directory, headers } = getContext();
    const { data } = await client.get<ArrayBuffer>("/read", { params: { directory, path }, headers, responseType: "arraybuffer" });
    return data;
  }

  async function importImage(url: string) {
    const { directory, headers } = getContext();
    const { data } = await client.post<{ data: { path: string; mimeType: string } }>("/importImage", { directory, url }, { headers });
    return data.data;
  }

  function acquireUrl(path: string, mimeType?: string) {
    const { directory, headers, projectId } = getContext();
    const key = JSON.stringify([directory, projectId, path, mimeType]);
    let entry = fileUrls.get(key);
    if (!entry) {
      const url = client.get<Blob>("/read", { params: { directory, path }, headers, responseType: "blob" })
        .then(({ data }) => URL.createObjectURL(mimeType ? new Blob([data], { type: mimeType }) : data));
      entry = { directory, path, url, users: 0 };
      fileUrls.set(key, entry);
      const current = entry;
      void url.catch(() => { if (fileUrls.get(key) === current) fileUrls.delete(key); });
    }
    const current = entry;
    current.users++;
    let released = false;
    return {
      url: current.url,
      release() {
        if (released) return;
        released = true;
        if (--current.users) return;
        if (fileUrls.get(key) === current) fileUrls.delete(key);
        // 等待中的读取也要在最后一个使用者离开后释放，不撤销其他节点仍使用的 URL。
        void current.url.then(url => URL.revokeObjectURL(url), () => {});
      },
    };
  }

  async function readText(path: string, maxBytes?: number, signal?: AbortSignal) {
    const { directory, headers } = getContext();
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    try {
      const { data } = await client.get<string>("/read", {
        params: { directory, path }, responseType: "text", transformResponse: [], signal,
        headers: { ...headers, ...(maxBytes === undefined ? {} : { Range: `bytes=0-${maxBytes - 1}` }) },
      });
      return data;
    } catch (error) {
      if (maxBytes !== undefined && axios.isAxiosError(error) && error.response?.status === 416 && error.response.headers["content-range"] === "bytes */0") return "";
      throw error;
    }
  }

  async function readJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
    const text = await readText(path, undefined, signal);
    signal?.throwIfAborted();
    return JSON.parse(text);
  }

  async function readTextSnapshot(path: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<TextSnapshot> {
    const { directory, headers } = getContext();
    if (options?.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    const { data } = await client.get<{ data: TextSnapshot }>("/read", {
      params: { directory, path, snapshot: true, maxBytes: options?.maxBytes }, headers, signal: options?.signal,
    });
    return data.data;
  }

  async function writeTextSnapshot(path: string, text: string, snapshot: Pick<TextSnapshot, "revision" | "encoding">) {
    const { directory, headers } = getContext();
    const { data } = await client.put<{ data: { revision: string } }>("/write", text, {
      params: { directory, path, expectedRevision: snapshot.revision, encoding: snapshot.encoding },
      headers: { ...headers, "Content-Type": "application/octet-stream" },
    });
    invalidateUrls(directory, path);
    return data.data.revision;
  }

  async function write(path: string, content: string | Blob | ArrayBuffer, exclusive = false, signal?: AbortSignal) {
    const { directory, headers } = getContext();
    await client.put("/write", content, { params: { directory, path, exclusive }, signal, headers: { ...headers, "Content-Type": "application/octet-stream" } });
    invalidateUrls(directory, path);
  }

  function writeJson(path: string, data: unknown, exclusive = false) {
    return write(path, `${JSON.stringify(data, null, 2)}\n`, exclusive);
  }

  async function rename(path: string, target: string) {
    const { directory, headers } = getContext();
    await client.post("/rename", { directory, path, target }, { headers });
    invalidateUrls(directory, path);
    invalidateUrls(directory, target);
  }

  async function copy(path: string, target: string) {
    const { directory, headers } = getContext();
    await client.post("/copy", { directory, path, target }, { headers });
    invalidateUrls(directory, target);
  }

  async function reveal(path: string) {
    if (isRemoteConnection) throw new Error("远程项目文件无法在本机文件管理器中定位，请下载或导出后查看。");
    if (isMobile) throw new Error("移动端暂不支持在文件管理器中定位项目文件，请使用下载或导出保存文件。");
    const { directory, headers } = getContext();
    await client.post("/reveal", { directory, path }, { headers });
  }

  async function remove(path: string, recursive = false) {
    const { directory, headers } = getContext();
    await client.delete("/remove", { data: { directory, path, recursive }, headers });
    invalidateUrls(directory, path);
  }

  async function mkdir(path: string) {
    const { directory, headers } = getContext();
    await client.post("/mkdir", { directory, path }, { headers });
  }

  // ACT: 每次操作同步取得目录和 ID；跨 await 或防抖应传入目录及项目 ID 字符串快照。
  return { list, read, importImage, acquireUrl, readText, readJson, readTextSnapshot, writeTextSnapshot, write, writeJson, rename, copy, reveal, remove, mkdir };
}
