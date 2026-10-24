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
});
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

export async function resolveRequestProject(req: Request) {
  const parsed = z.uuid().safeParse(req.get("x-toonflow-project-id"));
  if (!parsed.success) throw Object.assign(new Error("项目 ID 格式无效"), { status: 400 });
  const project = await getProject(req, parsed.data);
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
  const project = { id: randomUUID(), name, directory, createdAt: new Date().toISOString(), createdBy };
  writeAtomicSync(registryPath(), `${JSON.stringify([project, ...projects], null, 2)}\n`, { mode: 0o600 });
  return project;
}

export function listProjects(offset: number, limit: number) {
  const projects = readProjects();
  return { total: projects.length, projects: projects.slice(offset, offset + limit) };
}

export function findProjectId(directory: string) {
  return readProjects().find(project => relative(project.directory, directory) === "")?.id;
}
