import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import conf from "@/utils/conf";
import { z } from "zod";

// 优先使用环境变量；否则首次启动生成随机密钥并持久化，避免使用硬编码默认值
function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const saved = conf.get("jwtSecret") as string | undefined;
  if (saved) return saved;
  const secret = randomBytes(32).toString("hex");
  conf.set("jwtSecret", secret);
  return secret;
}

const jwtSecret = loadSecret();

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
  sessionVersion: number;
}

const tokenSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1),
  role: z.enum(["admin", "user"]),
  sessionVersion: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, jwtSecret, { algorithm: "HS256", expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload {
  try {
    return tokenSchema.parse(jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }));
  } catch {
    throw new Error("无效的 token");
  }
}
