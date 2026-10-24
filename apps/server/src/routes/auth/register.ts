import { Router } from "express";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { z } from "zod";

const router = Router();

router.post("/", validateFields({
  username: z.string().min(3, "用户名至少 3 个字符").max(20, "用户名最多 20 个字符"),
  password: z.string().min(6, "密码至少 6 个字符").max(1024),
  email: z.string().email("邮箱格式不正确").optional(),
}), async (req, res) => {
  try {
    const { username, password, email } = req.body;

    const user = u.userManager.register(username, password, email);

    const token = u.jwt.generateToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion ?? 0,
    });

    res.status(201).json(success({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "注册失败";
    res.status(400).json(error(message));
  }
});

export default router;
