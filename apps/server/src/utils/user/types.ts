/** 用户状态 */
export enum UserStatus {
  active = "active",
  disabled = "disabled",
  pending = "pending",
}

/** 用户角色 */
export enum UserRole {
  admin = "admin",
  user = "user",
}

/** 会员等级 */
export type MembershipLevel = "free" | "pro" | "enterprise";

/** 用户基础信息 */
export interface UserInfo {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  avatar?: string;
  role: UserRole;
  status: UserStatus;
  membershipLevel?: MembershipLevel;
  createdAt: Date;
  lastLoginAt?: Date;
  sessionVersion?: number;
}

/** 用户配额信息 */
export interface UserQuota {
  userId: string;
  providerId: string;
  remaining: number;
  total: number;
  unit: string;
  type: "count" | "amount";
  resetPeriod?: number;
  nextResetAt?: Date;
  updatedAt: Date;
}

/** 用户的 Provider 配置（个人自备密钥） */
export interface ProviderConfig {
  userId: string;
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  other?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserAuditEvent {
  id: string;
  createdAt: string;
  action: "administratorCreated" | "memberCreated" | "statusChanged" | "passwordChanged" | "sessionsRevoked";
  actor: { id: string; username: string } | null;
  target: { id: string; username: string };
  previousStatus?: UserStatus;
  status?: UserStatus;
}

/** 用户数据存储结构 */
export interface UserData {
  users: Record<string, UserInfo>;
  quotas: Record<string, UserQuota[]>;
  providerConfigs?: Record<string, ProviderConfig[]>;
  usernameIndex: Record<string, string>;
  auditEvents?: UserAuditEvent[];
}

/** 每日请求配额使用情况 */
export interface QuotaUsage {
  used: number;
  limit: number;
  resetAt?: Date;
}

export interface QuotaResponse {
  usage: QuotaUsage;
  membershipLevel: MembershipLevel;
}

/** 会员计划；-1 表示不限 */
export const membershipPlans = {
  free: { requestsPerDay: 100 },
  pro: { requestsPerDay: 1000 },
  enterprise: { requestsPerDay: -1 },
} as const satisfies Record<MembershipLevel, { requestsPerDay: number }>;
