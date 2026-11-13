import { Router } from "express";
import { readFile } from "@toonflow/file";
import { z } from "zod";
import u from "@/utils";
import skill from "@toonflow/mcp/skill" with { type: "text" };

export default Router().get("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const selection = z.object({ source: z.enum(["builtin", "custom", "installed"]), content: z.string().max(100000).optional(), name: z.string().max(1024).optional() }).parse(u.conf.get("settings", {}).mcpSkill ?? { source: "builtin" });
  let content = skill;
  if (selection.source === "custom") {
    if (!selection.content?.trim()) throw Object.assign(new Error("请填写自定义技能内容"), { status: 400 });
    content = selection.content;
  }
  if (selection.source === "installed") {
    if (!selection.name) throw Object.assign(new Error("请选择已安装技能"), { status: 400 });
    const { target } = await u.skillFile.locate(selection.name);
    content = await readFile(target, "utf8");
  }
  res.set({ "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="SKILL.md"', "Cache-Control": "no-store" }).send(content);
});
