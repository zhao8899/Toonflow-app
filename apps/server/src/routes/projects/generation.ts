import { Router } from "express";
import { z } from "zod";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().put("/", requireAdministrator, validateFields({
  id: z.uuid(), enabled: z.boolean(), billingOwner: z.literal("instance"), dailyLimit: z.number().int().min(0).max(1000),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (req.body.enabled && req.body.dailyLimit === 0) {
    throw Object.assign(new Error("启用成员生成时每日次数上限必须大于0"), { status: 400 });
  }
  await u.projects.getProject(req, req.body.id);
  const models = await u.mediaGeneration.listMediaModels();
  const project = await u.projects.getProject(req, req.body.id);
  if (req.body.enabled && !models.some(model => model.type === "video" && Array.isArray(model.mode) && model.mode.includes("text")
    && model.durationResolutionMap?.some(row => row.duration.some(duration => duration === 4 || duration === 5)
      && row.resolution.some(resolution => resolution === "720p" || resolution === "1080p"))
    && project.mediaModels.some(grant => grant.providerId === model.providerId && grant.modelId === model.modelId))) {
    throw Object.assign(new Error("请先授权至少一个支持4或5秒、720p或1080p的文生视频模型"), { status: 400 });
  }
  const actor = u.userManager.getUserById(res.locals.userId);
  if (!actor) throw Object.assign(new Error("Authenticated user not found"), { status: 401 });
  res.set("Cache-Control", "no-store").json(success(u.projects.publicProject(u.projects.setProjectGeneration(project.id, req.body.enabled, req.body.dailyLimit, { id: actor.id, username: actor.username }))));
});
