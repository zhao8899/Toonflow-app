import type { ProviderConfig } from "./types";
import conf from "@/utils/conf";

/**
 * 获取用户的 Provider 配置
 * @param userId 用户 ID
 * @param providerId Provider ID (可选,不传返回所有配置)
 */
export function getProviderConfig(userId: string, providerId?: string): ProviderConfig[] {
  const data = conf.get("userData") as { providerConfigs?: Record<string, ProviderConfig[]> } | undefined;
  const configs = data?.providerConfigs?.[userId] || [];

  if (providerId) {
    return configs.filter((c) => c.providerId === providerId);
  }
  return configs;
}

/**
 * 保存或更新用户的 Provider 配置
 * @param userId 用户 ID
 * @param providerId Provider ID
 * @param apiKey API Key
 * @param baseUrl Base URL (可选)
 * @param other 其他配置 (可选)
 */
export function saveProviderConfig(
  userId: string,
  providerId: string,
  apiKey: string,
  baseUrl?: string,
  other?: Record<string, unknown>
): void {
  const data = conf.get("userData") as { providerConfigs?: Record<string, ProviderConfig[]> } | undefined;
  const providerConfigs = data?.providerConfigs || {};
  const userConfigs = providerConfigs[userId] || [];

  const existingIndex = userConfigs.findIndex((c) => c.providerId === providerId);
  const now = new Date();

  if (existingIndex >= 0) {
    // 更新现有配置
    userConfigs[existingIndex] = {
      ...userConfigs[existingIndex],
      apiKey,
      baseUrl,
      other,
      updatedAt: now,
    };
  } else {
    // 新建配置
    userConfigs.push({
      userId,
      providerId,
      apiKey,
      baseUrl,
      other,
      createdAt: now,
      updatedAt: now,
    });
  }

  providerConfigs[userId] = userConfigs;
  conf.set("userData.providerConfigs", providerConfigs);
}

/**
 * 删除用户的 Provider 配置
 * @param userId 用户 ID
 * @param providerId Provider ID
 */
export function deleteProviderConfig(userId: string, providerId: string): void {
  const data = conf.get("userData") as { providerConfigs?: Record<string, ProviderConfig[]> } | undefined;
  const providerConfigs = data?.providerConfigs || {};
  const userConfigs = providerConfigs[userId] || [];

  providerConfigs[userId] = userConfigs.filter((c) => c.providerId !== providerId);
  conf.set("userData.providerConfigs", providerConfigs);
}

/**
 * 获取用户在指定 Provider 上的 API Key
 * 优先返回用户自己配置的,否则返回企业配置(如果存在)
 * @param userId 用户 ID
 * @param providerId Provider ID
 * @returns API Key 或 undefined
 */
export function getApiKey(userId: string, providerId: string): string | undefined {
  // 1. 查找用户自己的配置
  const userConfigs = getProviderConfig(userId, providerId);
  if (userConfigs.length > 0 && userConfigs[0].apiKey) {
    return userConfigs[0].apiKey;
  }

  // 2. 查找企业级配置 (从全局配置读取)
  const enterpriseKey = conf.get(`enterprise.providers.${providerId}.apiKey`) as string | undefined;
  return enterpriseKey;
}
