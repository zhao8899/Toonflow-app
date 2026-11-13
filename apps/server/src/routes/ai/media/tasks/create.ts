import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { Router } from "express";
import { z } from "zod";
import { audioGenerationSchema, imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { translateMessage, validationOptions } from "@/lib/i18n";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), mediaType: z.enum(["image", "video", "audio"]), requestId: z.uuid(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const expectedUserId = req.get("x-toonflow-user-id");
  if (expectedUserId !== undefined && expectedUserId !== res.locals.userId) {
    throw Object.assign(new Error("登录账号已变化，请刷新页面后继续"), { status: 403 });
  }
  const { directory, mediaType, requestId, ...request } = req.body;
  const parsed = (mediaType === "image" ? imageGenerationSchema : mediaType === "video" ? videoGenerationSchema : audioGenerationSchema)
    .safeParse(request, validationOptions());
  if (!parsed.success) {
    res.status(400).json(error("参数错误", parsed.error.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400));
    return;
  }
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const user = res.locals.userId ? u.userManager.getUserById(res.locals.userId) : null;
  const member = !!req.app.locals.authRequired && res.locals.userRole !== "admin";
  let authorize: (() => void) | undefined;
  if (member) {
    const project = await u.projects.resolveRequestProject(req, res.locals.userId, res.locals.userRole);
    const models = await u.mediaGeneration.listMediaModels();
    const model = models.find(model => model.providerId === parsed.data.providerId && model.modelId === parsed.data.modelId);
    const input: MediaGenerationRequest = parsed.data;
    if (mediaType !== "video" || !model || model.type !== "video" || !Array.isArray(model.mode) || !model.mode.includes("text")
      || input.mode !== "text" || !input.prompt.trim() || input.prompt.length > 10000
      || !["720p", "1080p"].includes(input.resolution ?? "")
      || !model.durationResolutionMap?.some(item => item.duration.includes(input.duration!) && item.resolution.includes(input.resolution!))
      || input.ratio !== "16:9" || typeof input.generateAudio !== "boolean"
      || model.audio !== "optional" && input.generateAudio !== (model.audio === true)
      || ["images", "videos", "audios", "firstFrame", "lastFrame", "other", "outputDirectory"].some(key => key in request)) {
      throw Object.assign(new Error("成员仅可使用授权模型生成模型支持时长、720p或1080p的16:9纯文本视频"), { status: 400 });
    }
    authorize = () => {
      const current = u.userManager.getUserById(res.locals.userId);
      if (!current || current.status !== "active" || current.role !== "user"
        || (current.sessionVersion ?? 0) !== (user?.sessionVersion ?? 0)) {
        throw Object.assign(new Error("成员账号已失效"), { status: 403 });
      }
      u.projects.assertMemberGeneration(project.id, current.id, input.providerId, input.modelId);
    };
    authorize();
  }
  const task = await u.mediaGeneration.submitMediaGeneration(cwd, mediaType, parsed.data, requestId,
    user ? { id: user.id, username: user.username, member } : undefined, authorize);
  res.status(202).set("Cache-Control", "no-store").json(success(task));
});
