import { Router } from "express";
import { z } from "zod";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", requireAdministrator, validateFields({
  directory: z.string().min(1).max(4096), name: z.string().trim().min(1).max(100),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.projects.resolveProjectDirectory(req, req.body.directory);
  res.set("Cache-Control", "no-store").json(success(u.projects.registerProject(directory, req.body.name.trim(), res.locals.userId)));
});
