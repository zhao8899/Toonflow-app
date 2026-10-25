import { Router } from "express";
import u from "@/utils";
import { requireSameOrigin, validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { z } from "zod";

const router = Router();

router.post("/", (req, res, next) => {
  if (req.app.locals.authRequired) return requireSameOrigin(req, res, next);
  next();
}, validateFields({
  username: z.string().min(1, "用户名不能为空").max(20),
  password: z.string().min(1, "密码不能为空").max(1024),
}), async (req, res) => {
  try {
    const { username, password } = req.body;

    // 成员账号可登录，访问范围由 requireAccess 的默认拒绝名单与项目成员关系限制。
    const user = u.userManager.login(username, password);

    const token = u.jwt.generateToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion ?? 0,
    });

    res.setHeader("Cache-Control", "no-store");
    if (req.app.locals.authRequired) {
      res.cookie("toonflowSession", token, { ...u.userAccess.sessionCookie(req), maxAge: 7 * 24 * 60 * 60 * 1000 });
    }
    res.status(200).json(success({
      ...(req.app.locals.authRequired ? {} : { token }),
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
    if ((err as { status?: number } | null)?.status !== 401) throw err;
    const message = err instanceof Error ? err.message : "登录失败";
    res.status(401).json(error(message, null, 401));
  }
});

export default router;
