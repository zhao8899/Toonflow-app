import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import userManager from "./manager";
import { UserRole } from "./types";
import { requireAuth } from "@/lib/middleware";
import { error } from "@/lib/responseFormat";
import { getRuntimePlatform } from "@/lib/platform";

export function initializeAccess() {
  const mode = process.env.TOONFLOW_AUTH_REQUIRED;
  if (mode && mode !== "true" && mode !== "false") throw new Error("TOONFLOW_AUTH_REQUIRED 必须为 true 或 false");
  if (mode !== "true") return false;
  if (getRuntimePlatform().host) throw new Error("登录保护模式仅支持独立 server，请通过浏览器访问；原生客户端请保持单机模式");
  if (!userManager.hasAdministrator()) {
    const credentials = z.object({
      username: z.string().min(3).max(20),
      password: z.string().min(12).max(1024),
    }).safeParse({ username: process.env.TOONFLOW_ADMIN_USERNAME, password: process.env.TOONFLOW_ADMIN_PASSWORD });
    if (!credentials.success) throw new Error("首次启用登录保护需设置 TOONFLOW_ADMIN_USERNAME 和至少 12 位的 TOONFLOW_ADMIN_PASSWORD");
    // 不提升已有普通账号，避免通过重名接管管理员。
    userManager.register(credentials.data.username, credentials.data.password, undefined, UserRole.admin);
  }
  return true;
}

export function sessionCookie(req: Request) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: req.secure || !["localhost", "127.0.0.1", "[::1]"].includes(req.hostname),
    path: "/",
  };
}

export function requireAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.app.locals.authRequired) return next();
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.path === "/auth/status" || req.method === "POST" && req.path === "/auth/login") return next();
  if (req.path.toLowerCase().replace(/\/+$/, "") === "/auth/register") {
    return res.status(403).json(error("登录保护模式不开放注册", null, 403));
  }
  if (/^\/(mcp|mobileLink)(\/|$)/i.test(req.path)) {
    return res.status(403).json(error("登录保护模式暂不开放 MCP 和设备互联", null, 403));
  }
  return requireAuth(req, res, (cause?: unknown) => {
    if (cause) return next(cause);
    if (res.locals.userRole === "admin") return next();
    // 成员默认拒绝：只开放会话、项目入口、项目内只读文件与审片接口；项目接口须携带项目 ID，由项目上下文中间件核对成员身份。
    // ACT: 成员暂无画布/文档入口，不开放文件写入、改名、复制和删除；开放创作时再按项目权限细分。
    const path = req.path.toLowerCase().replace(/\/+$/, "");
    const scope = memberRoutes.find(route => route.path === path && route.methods.includes(req.method));
    if (!scope) return res.status(403).json(error("成员账号无权访问此功能", null, 403));
    if (scope.project && req.get("x-toonflow-project-id") === undefined) return res.status(403).json(error("成员访问项目内容必须指定项目", null, 403));
    next();
  });
}

const memberRoutes = [
  { path: "/auth/session", methods: ["GET", "HEAD"], project: false },
  { path: "/auth/changepassword", methods: ["POST"], project: false },
  { path: "/auth/revokesessions", methods: ["POST"], project: false },
  { path: "/projects/list", methods: ["GET", "HEAD"], project: false },
  { path: "/projects/get", methods: ["GET", "HEAD"], project: false },
  { path: "/workspaces/files/list", methods: ["GET", "HEAD"], project: true },
  { path: "/workspaces/files/read", methods: ["GET", "HEAD"], project: true },
  { path: "/ai/media/tasks/list", methods: ["GET", "HEAD"], project: true },
  { path: "/ai/media/tasks/get", methods: ["GET", "HEAD"], project: true },
  { path: "/ai/media/tasks/reviewhistory", methods: ["GET", "HEAD"], project: true },
  { path: "/ai/media/tasks/review", methods: ["PUT"], project: true },
];

const loginAttempts = new Map<string, { count: number; expiresAt: number }>();
let loginWindow = { count: 0, expiresAt: 0 };

export function limitLogin(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  for (const [key, value] of loginAttempts) if (value.expiresAt <= now) loginAttempts.delete(key);
  if (loginWindow.expiresAt <= now) loginWindow = { count: 0, expiresAt: now + 60_000 };
  const key = req.socket.remoteAddress ?? "unknown";
  const attempt = loginAttempts.get(key) ?? { count: 0, expiresAt: now + 300_000 };
  // ACT: 单进程、按实际连接 IP 限流，不信任客户端转发头；代理后的客户端共享限额。
  if (attempt.count >= 10 || loginWindow.count >= 100 || loginAttempts.size >= 10000 && !loginAttempts.has(key)) {
    res.setHeader("Retry-After", String(Math.ceil((Math.max(attempt.expiresAt, loginWindow.expiresAt) - now) / 1000)));
    return res.status(429).json(error("身份验证尝试过多，请稍后重试", null, 429));
  }
  attempt.count++;
  loginWindow.count++;
  loginAttempts.set(key, attempt);
  next();
}
