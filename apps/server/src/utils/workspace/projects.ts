import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { readFileSync, writeAtomicSync, realpath } from "@toonflow/file";
import type { Request } from "express";
import { z } from "zod";
import conf from "@/utils/conf";
import { resolveWorkspace } from "@/utils/workspace";

const projectSchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(100), directory: z.string().min(1),
  createdAt: z.string(), createdBy: z.string().min(1),
  // 旧登记记录没有成员字段，读取时视为无成员。
  members: z.array(z.string()).default([]),
});
type Project = z.infer<typeof projectSchema>;
const registryPath = () => resolve(dirname(conf.path), "projects.json");

function readProjects() {
  try { return z.array(projectSchema).parse(JSON.parse(readFileSync(registryPath(), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function contains(parent: string, child: string) {
  const offset = relative(parent, child);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

export async function resolveProjectDirectory(req: Request, path: string) {
  const directory = await resolveWorkspace(req, path);
  const root = await realpath(resolve(dirname(conf.path), "workspaces"));
  if (relative(root, directory) === "" || !contains(root, directory)) {
    throw Object.assign(new Error("项目必须使用服务器工作区内的独立子目录"), { status: 403 });
  }
  return directory;
}

export async function getProject(req: Request, id: string) {
  const project = readProjects().find(project => project.id === id.toLowerCase());
  if (!project) throw Object.assign(new Error("项目不存在"), { status: 404 });
  const directory = await resolveProjectDirectory(req, project.directory);
  if (relative(project.directory, directory) !== "") {
    throw Object.assign(new Error("已登记项目目录指向发生变化，请管理员核对"), { status: 409 });
  }
  return { ...project, directory };
}

/** 非成员与不存在同样返回 404，避免借此探测项目 ID；成员视图不返回成员名单。 */
export async function getMemberProject(req: Request, id: string, userId: string, role: string) {
  const project = readProjects().find(project => project.id === id.toLowerCase());
  if (!project || !canAccessProject(project, userId, role)) throw Object.assign(new Error("项目不存在"), { status: 404 });
  const resolved = await getProject(req, id);
  return role === "admin" ? resolved : { ...resolved, members: [] };
}

export async function resolveRequestProject(req: Request, userId: string, role: string) {
  const parsed = z.uuid().safeParse(req.get("x-toonflow-project-id"));
  if (!parsed.success) throw Object.assign(new Error("项目 ID 格式无效"), { status: 400 });
  const project = await getMemberProject(req, parsed.data, userId, role);
  const requestedDirectory = ["GET", "HEAD"].includes(req.method) || req.is("application/octet-stream")
    ? req.query.directory : req.body?.directory;
  if (typeof requestedDirectory !== "string" || !isAbsolute(requestedDirectory)) {
    throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
  }
  const directory = await resolveWorkspace(req, requestedDirectory);
  if (relative(project.directory, directory) !== "") {
    throw Object.assign(new Error("项目 ID 与请求工作目录不匹配"), { status: 403 });
  }
  return project;
}

export function registerProject(directory: string, name: string, createdBy: string) {
  // ACT: 目录由接口规范化与授权；单进程同步读改写，小团队规模，扩容时迁移数据库唯一约束。
  const projects = readProjects();
  const existing = projects.find(project => relative(project.directory, directory) === "");
  if (existing) {
    if (existing.name !== name) throw Object.assign(new Error("此目录已登记，请使用已有项目名称"), { status: 409 });
    return existing;
  }
  if (projects.some(project => contains(project.directory, directory) || contains(directory, project.directory))) {
    throw Object.assign(new Error("项目目录不能与已登记项目相互包含"), { status: 409 });
  }
  const project: Project = { id: randomUUID(), name, directory, createdAt: new Date().toISOString(), createdBy, members: [] };
  saveProjects([project, ...projects]);
  return project;
}

function saveProjects(projects: Project[]) {
  writeAtomicSync(registryPath(), `${JSON.stringify(projects, null, 2)}\n`, { mode: 0o600 });
}

/** 管理员可见完整记录；成员只能看到自己加入的项目，且不返回成员名单。 */
export function listProjects(offset: number, limit: number, memberId?: string) {
  const projects = memberId ? readProjects().filter(project => project.members.includes(memberId)) : readProjects();
  return {
    total: projects.length,
    projects: projects.slice(offset, offset + limit).map(project => memberId ? { ...project, members: [] } : project),
  };
}

export function canAccessProject(project: Project, userId: string, role: string) {
  return role === "admin" || project.members.includes(userId);
}

/** 完整覆盖项目成员名单；成员须为现有普通账号，管理员本身已可访问全部项目。 */
export function setProjectMembers(id: string, members: string[], isMember: (userId: string) => boolean) {
  const projects = readProjects();
  const project = projects.find(project => project.id === id.toLowerCase());
  if (!project) throw Object.assign(new Error("项目不存在"), { status: 404 });
  const unique = [...new Set(members)];
  if (unique.some(userId => !isMember(userId))) throw Object.assign(new Error("成员必须是现有普通账号"), { status: 400 });
  project.members = unique;
  saveProjects(projects);
  return project;
}

export function findProjectId(directory: string) {
  return readProjects().find(project => relative(project.directory, directory) === "")?.id;
}
