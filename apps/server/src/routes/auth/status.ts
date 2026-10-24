import { Router } from "express";
import { success } from "@/lib/responseFormat";

const router = Router();

router.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(success({ required: req.app.locals.authRequired === true }));
});

export default router;
