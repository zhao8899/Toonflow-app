import { Router } from "express";
import u from "@/utils";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { z } from "zod";

const router = Router();

router.get("/", requireAuth, validateFields({
  providerId: z.string().optional(),
}, "query"), (req, res) => {
  const userId = res.locals.userId as string;
  const { providerId } = req.query as { providerId?: string };
  // 不回传明文密钥，只告知是否已配置
  const configs = u.providerConfig.getProviderConfig(userId, providerId).map(({ apiKey, ...rest }) => ({ ...rest, hasApiKey: Boolean(apiKey) }));
  res.json(success(configs));
});

export default router;
