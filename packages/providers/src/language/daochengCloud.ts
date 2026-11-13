const rules = [{ type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } }];

export default {
  id: "daochengCloud" as const,
  label: "道成云",
  icon: "",
  version: "1.0.1",
  apiUrl: "https://www.fytoken.net/v1",
  protocol: "openai-completions",
  readme: "填写平台 API Key 后读取当前令牌可见的文本模型列表，不调用生成接口。旧模型 ID 与当前名称的别名关系尚未确认，请按平台返回的准确 ID 选择，不按相似名称替换已有配置。",
  rules,
  models: [],
} satisfies ProviderDefinition<typeof rules>;
