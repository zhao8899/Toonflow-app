import { Router } from "express";
import { z } from "zod";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", requireAuth, validateFields({
  offset: z.string().regex(/^\d{1,8}$/).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(),
}, "query"), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const memberId = res.locals.userRole === "admin" ? undefined : res.locals.userId;
  res.set("Cache-Control", "no-store").json(success(u.projects.listProjects(Number(req.query.offset ?? 0), Number(req.query.limit ?? 30), memberId)));
});
