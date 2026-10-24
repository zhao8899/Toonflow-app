import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

router.put("/", requireAdministrator, validateFields({
  userId: z.string().min(1).max(100),
  status: z.enum(["active", "disabled"]),
}), (req, res) => {
  u.userManager.updateUserStatus(req.body.userId, req.body.status, res.locals.userId);
  res.setHeader("Cache-Control", "no-store");
  if (req.body.userId === res.locals.userId && req.body.status === "disabled") {
    res.clearCookie("toonflowSession", u.userAccess.sessionCookie(req));
  }
  res.json(success());
});

export default router;
