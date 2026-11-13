import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { costInputSchema } from "@/utils/media/tasks";

export default Router().put("/", validateFields({
  directory: z.string().min(1).max(4096), id: z.uuid(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), ...costInputSchema.shape,
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (req.app.locals.authRequired && res.locals.userRole !== "admin") throw Object.assign(new Error("仅管理员可核对成本"), { status: 403 });
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const user = res.locals.userId ? u.userManager.getUserById(res.locals.userId) : null;
  const parsed = costInputSchema.safeParse(req.body);
  if (!parsed.success) throw Object.assign(new Error("已核对费用必须填写有效金额"), { status: 400 });
  const result = u.mediaTasks.recordMediaTaskCost(directory, req.body.id, req.body.revision, parsed.data, user ? { id: user.id, username: user.username } : null);
  res.set("Cache-Control", "no-store").json(success(result));
});
