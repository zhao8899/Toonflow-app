import { Router } from "express";
import { z } from "zod";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", requireAdministrator, validateFields({ directory: z.string().min(1).max(4096), id: z.uuid() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const task = await u.mediaGeneration.resumeMediaGeneration(directory, req.body.id);
  res.status(202).set("Cache-Control", "no-store").json(success(task));
});
