import { Router } from "express";
import { z } from "zod";
import type { MediaTaskFilters } from "@toonflow/tools-scaffold/runtime";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096),
  mediaType: z.enum(["image", "video", "audio"]).optional(),
  status: z.enum(["queued", "running", "saving", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]).optional(),
  reviewState: z.enum(["pending", "approved", "changesRequested"]).optional(),
  offset: z.string().regex(/^\d{1,8}$/).optional(),
  limit: z.string().regex(/^\d{1,3}$/).refine(value => Number(value) >= 1 && Number(value) <= 100).optional(),
}, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  res.set("Cache-Control", "no-store").json(success(u.mediaTasks.listMediaTasks(directory,
    Number(req.query.offset ?? 0), Number(req.query.limit ?? 30), {
      mediaType: req.query.mediaType as MediaTaskFilters["mediaType"],
      status: req.query.status as MediaTaskFilters["status"],
      reviewState: req.query.reviewState as MediaTaskFilters["reviewState"],
    })));
});
