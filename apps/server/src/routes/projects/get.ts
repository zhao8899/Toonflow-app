import { Router } from "express";
import { z } from "zod";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", requireAuth, validateFields({ id: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store").json(success(await u.projects.getMemberProject(req, req.query.id as string, res.locals.userId, res.locals.userRole)));
});
