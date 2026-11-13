import { Router } from "express";
import { z } from "zod";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", requireAuth, validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const models = await u.mediaGeneration.listMediaModels();
  // 在异步加载模型之后重新核对项目成员，避免返回已撤销的授权。
  const project = await u.projects.resolveRequestProject(req, res.locals.userId, res.locals.userRole);
  res.set("Cache-Control", "no-store").json(success(models.filter(model => project.mediaModels.some(grant =>
    grant.providerId === model.providerId && grant.modelId === model.modelId))));
});
