import { Router } from "express";
import u from "@/utils";
import { requireAuth } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

router.post("/", requireAuth, (req, res) => {
  u.userManager.revokeSessions(res.locals.userId);
  res.clearCookie("toonflowSession", u.userAccess.sessionCookie(req));
  res.setHeader("Cache-Control", "no-store");
  res.json(success(null, "全部登录会话已撤销"));
});

export default router;
