import { Router } from "express";
import u from "@/utils";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { z } from "zod";

const router = Router();

router.put("/", requireAuth, validateFields({
  providerId: z.string().min(1, "providerId 不能为空"),
  apiKey: z.string().min(1, "apiKey 不能为空"),
  baseUrl: z.string().url().optional(),
  other: z.record(z.string(), z.unknown()).optional(),
}), (req, res) => {
  const userId = res.locals.userId as string;
  const { providerId, apiKey, baseUrl, other } = req.body;
  u.providerConfig.saveProviderConfig(userId, providerId, apiKey, baseUrl, other);
  res.json(success(null, "保存成功"));
});

export default router;
