import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { error } from "./responseFormat";
import { t, translateMessage, validationOptions } from "./i18n";

export function validateFields(
  shape: Record<string, z.ZodType>,
  source: "body" | "query" | "params" = "body", // 默认校验 body
) {
  const schema = z.object(shape);

  return (req: Request, res: Response, next: NextFunction) => {
    const data = req[source];
    const parseResult = schema.safeParse(data, validationOptions());
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((issue) => t`字段 ${issue.path.join(".")} ${translateMessage(issue.message)}`);
      console.error(errors);
      return res.status(400).json(error("参数错误", errors));
    }
    next();
  };
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  const source = req.get("origin") || req.get("referer");
  try {
    const url = new URL(source ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.host !== req.get("host")) throw new Error("origin");
  } catch {
    return res.status(403).json(error("请求来源无效", null, 403));
  }
  next();
}

/** JWT 鉴权；登录保护模式额外支持 HttpOnly 会话 cookie。 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const cookie = req.app.locals.authRequired
    ? req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("toonflowSession="))?.slice("toonflowSession=".length)
    : undefined;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : header ? undefined : cookie;
  if (!token) return res.status(401).json(error("未提供认证令牌", null, 401));
  if (!header && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    let allowed = false;
    requireSameOrigin(req, res, () => { allowed = true; });
    if (!allowed) return;
  }
  // ACT: 动态导入，避免中间件模块加载时就初始化 conf 与密钥
  const { verifyToken } = await import("@/utils/user/jwt");
  const { default: userManager } = await import("@/utils/user/manager");
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json(error("认证令牌无效或已过期", null, 401));
  }
  const user = userManager.getUserById(payload.userId);
  if (!user || user.status !== "active" || (user.sessionVersion ?? 0) !== payload.sessionVersion) {
    return res.status(401).json(error("账号不可用或会话已撤销，请重新登录", null, 401));
  }
  res.locals.userId = user.id;
  res.locals.userRole = user.role;
  next();
}

export function requireAdministrator(req: Request, res: Response, next: NextFunction) {
  return requireAuth(req, res, (cause?: unknown) => {
    if (cause) return next(cause);
    if (res.locals.userRole !== "admin") return res.status(403).json(error("仅管理员可执行此操作", null, 403));
    next();
  });
}
