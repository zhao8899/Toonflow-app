import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (req.app.locals.authRequired && res.locals.userRole !== "admin") throw Object.assign(new Error("仅管理员可查看日志容量"), { status: 403 });
  res.set("Cache-Control", "no-store").json(success(u.activity.getActivityStatus()));
});
