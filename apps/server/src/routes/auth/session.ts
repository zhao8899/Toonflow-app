import { Router } from "express";
import { requireAuth } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const router = Router();

router.get("/", requireAuth, (_req, res) => {
  const user = u.userManager.getUserById(res.locals.userId)!;
  res.setHeader("Cache-Control", "no-store");
  res.json(success({ username: user.username, role: user.role }));
});

export default router;
