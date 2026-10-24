import { Router } from "express";
import u from "@/utils";
import { requireAuth } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

router.get("/", requireAuth, (req, res) => {
  const quotas = u.userManager.getUserQuotas(res.locals.userId as string);
  res.json(success({ quotas }));
});

export default router;
