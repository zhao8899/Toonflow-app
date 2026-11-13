import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ day: z.iso.date().optional(), startDay: z.iso.date().optional(), endDay: z.iso.date().optional(), taskId: z.uuid().optional() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (req.app.locals.authRequired && res.locals.userRole !== "admin") throw Object.assign(new Error("仅管理员可导出操作日志"), { status: 403 });
  if (req.query.startDay !== undefined || req.query.endDay !== undefined) {
    if (!req.query.startDay || !req.query.endDay || !req.query.taskId || req.query.day !== undefined) {
      throw Object.assign(new Error("跨天查询须同时提供起止日期和任务ID，不能混用单日日期"), { status: 400 });
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    if (req.aborted || res.destroyed) cancel();
    try {
      const result = await u.activity.findTaskActivity(req.query.startDay as string, req.query.endDay as string, req.query.taskId as string, controller.signal);
      if (!controller.signal.aborted) res.set("Cache-Control", "no-store").json(success(result));
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { req.off("aborted", cancel); res.off("close", cancel); }
    return;
  }
  if (!req.query.day) throw Object.assign(new Error("请选择日志日期"), { status: 400 });
  const events = u.activity.exportActivity(req.query.day as string, req.query.taskId as string | undefined);
  res.set("Cache-Control", "no-store").json(success({ day: req.query.day, timezone: "UTC", events }));
});
