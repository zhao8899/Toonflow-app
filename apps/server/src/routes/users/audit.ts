import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

router.get("/", requireAdministrator, validateFields({
  offset: z.string().regex(/^\d{1,8}$/).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(),
}, "query"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(success(u.userManager.listAuditEvents(Number(req.query.offset ?? 0), Number(req.query.limit ?? 30))));
});

export default router;
