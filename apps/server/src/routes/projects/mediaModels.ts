import { Router } from "express";
import { z } from "zod";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().put("/", requireAdministrator, validateFields({
  id: z.uuid(), models: z.array(u.projects.mediaModelGrantSchema).max(100),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  await u.projects.getProject(req, req.body.id);
  const models = await u.mediaGeneration.listMediaModels();
  const grants = req.body.models as z.infer<typeof u.projects.mediaModelGrantSchema>[];
  if (grants.some(grant => !models.some(model => model.providerId === grant.providerId && model.modelId === grant.modelId))) {
    throw Object.assign(new Error("只能授权当前已安装的媒体模型"), { status: 400 });
  }
  res.set("Cache-Control", "no-store").json(success(u.projects.publicProject(u.projects.setProjectMediaModels(req.body.id, grants))));
});
