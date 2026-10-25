import { Router } from "express";
import { z } from "zod";
import { requireAdministrator, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().put("/", requireAdministrator, validateFields({
  id: z.uuid(), members: z.array(z.string().min(1).max(100)).max(100),
}), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const project = u.projects.setProjectMembers(req.body.id, req.body.members,
    userId => u.userManager.getUserById(userId)?.role === u.userTypes.UserRole.user);
  res.set("Cache-Control", "no-store").json(success(project));
});
