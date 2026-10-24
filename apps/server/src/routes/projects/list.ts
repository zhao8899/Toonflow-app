import { Router } from "express";
import { z } from "zod";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", requireAdministrator, validateFields({
  offset: z.string().regex(/^\d{1,8}$/).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(),
}, "query"), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store").json(success(u.projects.listProjects(Number(req.query.offset ?? 0), Number(req.query.limit ?? 30))));
});
