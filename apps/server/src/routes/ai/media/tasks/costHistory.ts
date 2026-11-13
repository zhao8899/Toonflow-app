import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), id: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (req.app.locals.authRequired && res.locals.userRole !== "admin") throw Object.assign(new Error("仅管理员可核对成本"), { status: 403 });
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  res.set("Cache-Control", "no-store").json(success(u.mediaTasks.getMediaTaskCostHistory(directory, req.query.id as string)));
});
