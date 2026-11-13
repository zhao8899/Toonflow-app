import conf from "@/utils/conf";

export default function migrateProviderDefaults() {
  const settings = conf.get("settings", {});
  if (settings.pluginMarketApiKey) return;
  const providers = Array.isArray(settings.customProviders) ? settings.customProviders : [];
  const marketProvider = providers.find(provider => provider?.id === "tfRouter"
    && typeof provider.apiUrl === "string" && URL.canParse(provider.apiUrl)
    && new URL(provider.apiUrl).origin === "https://api.toonflow.net");
  // 品牌和默认接入调整不得删除旧供应商；原任务恢复依赖原模型及原配置。
  if (typeof marketProvider?.apiKey === "string" && marketProvider.apiKey) {
    conf.set("settings.pluginMarketApiKey", marketProvider.apiKey);
  }
}
