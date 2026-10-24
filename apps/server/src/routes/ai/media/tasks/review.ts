import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().put("/", validateFields({
  directory: z.string().min(1).max(4096), id: z.uuid(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  decision: z.enum(["approved", "changesRequested"]), comment: z.string().max(2000),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const user = res.locals.userId ? u.userManager.getUserById(res.locals.userId) : undefined;
  const reviewer = user ? { id: user.id, username: user.username } : null;
  const { id, revision, decision, comment } = req.body;
  res.set("Cache-Control", "no-store").json(success(u.mediaTasks.reviewMediaTask(directory, id, revision, decision, comment, reviewer)));
});
