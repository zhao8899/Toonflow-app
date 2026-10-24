import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

router.post("/", requireAuth, validateFields({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
}), (req, res) => {
  u.userManager.changePassword(res.locals.userId, req.body.currentPassword, req.body.newPassword);
  res.clearCookie("toonflowSession", u.userAccess.sessionCookie(req));
  res.setHeader("Cache-Control", "no-store");
  res.json(success(null, "密码已修改，请重新登录"));
});

export default router;
