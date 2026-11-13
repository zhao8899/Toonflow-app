import { Router } from "express";
import { z } from "zod";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", requireAdministrator, validateFields({ id: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const project = await u.projects.getProject(req, req.query.id as string);
  // Small-team snapshot: retain at most 100 changes, newest first, without pagination.
  res.set("Cache-Control", "no-store").json(success([...project.generationAudit].reverse()));
});
