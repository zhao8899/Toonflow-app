import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

router.post("/", requireAdministrator, validateFields({
  username: z.string().min(3).max(20).refine(value => value === value.trim(), "用户名首尾不能包含空白"),
  password: z.string().min(12).max(1024),
}), (req, res) => {
  const user = u.userManager.register(req.body.username, req.body.password, undefined, u.userTypes.UserRole.admin, res.locals.userId);
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json(success({ id: user.id, username: user.username, role: user.role, status: user.status }));
});

export default router;
