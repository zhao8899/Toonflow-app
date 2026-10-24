import { Router } from "express";
import u from "@/utils";
import { requireAuth, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { z } from "zod";

const router = Router();

router.delete("/", requireAuth, validateFields({
  providerId: z.string().min(1, "providerId 不能为空"),
}), (req, res) => {
  const userId = res.locals.userId as string;
  const { providerId } = req.body;
  u.providerConfig.deleteProviderConfig(userId, providerId);
  res.json(success(null, "删除成功"));
});

export default router;
