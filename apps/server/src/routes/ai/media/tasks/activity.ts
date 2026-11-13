import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const schema = z.object({ directory: z.string().min(1).max(4096), action: z.enum(["promptApplied", "promptRestored"]), prompt: z.string().max(10000), assistanceId: z.uuid().optional() });
export default Router().post("/", validateFields(schema.shape), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (req.get("x-toonflow-user-id") !== undefined && req.get("x-toonflow-user-id") !== res.locals.userId) throw Object.assign(new Error("登录账号已变化，请刷新页面后继续"), { status: 403 });
  const input = schema.parse(req.body);
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  u.activity.recordActivity({ kind: "interaction", source: "clientReported", ...input, directory, actorId: res.locals.userId ?? null, projectId: res.locals.project?.id });
  res.json(success(null));
});
