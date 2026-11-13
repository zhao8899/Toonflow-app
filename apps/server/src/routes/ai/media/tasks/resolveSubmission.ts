import { Router } from "express";
import { z } from "zod";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const attempts = new Map<string, { count: number; expiresAt: number }>();

export default Router().post("/", requireAuth, validateFields({
  directory: z.string().min(1).max(4096), requestId: z.uuid(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (req.get("x-toonflow-user-id") !== res.locals.userId) throw Object.assign(new Error("登录账号已变化，请刷新页面后继续"), { status: 403 });
  const user = u.userManager.getUserById(res.locals.userId);
  const project = await u.projects.resolveRequestProject(req, res.locals.userId, res.locals.userRole);
  const current = u.userManager.getUserById(res.locals.userId);
  const currentProject = u.projects.findProject(project.directory);
  if (!current || current.status !== "active" || current.role !== res.locals.userRole || (current.sessionVersion ?? 0) !== (user?.sessionVersion ?? 0)
    || !currentProject || !u.projects.canAccessProject(currentProject, current.id, current.role)) {
    throw Object.assign(new Error("账号或项目授权已失效"), { status: 403 });
  }
  const now = Date.now();
  for (const [id, attempt] of attempts) if (attempt.expiresAt <= now) attempts.delete(id);
  const attempt = attempts.get(current.id) ?? { count: 0, expiresAt: now + 60000 };
  // ACT: 单进程每账号每分钟最多确认 30 次，最多记录 10000 个账号；不耦合登录或生成额度。
  if (attempt.count >= 30 || attempts.size >= 10000 && !attempts.has(current.id)) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((attempt.expiresAt - now) / 1000))));
    res.status(429).json(error("提交确认过于频繁，请稍后重试", null, 429));
    return;
  }
  attempt.count++;
  attempts.set(current.id, attempt);
  const result = u.mediaTasks.resolveMediaSubmission(project.directory, req.body.requestId, project.id, current.id);
  res.set("Cache-Control", "no-store").json(success(result));
});
