# DCtiv / Toonflow

本仓库在Toonflow开源项目基础上维护，当前应用界面名称为DCtiv；源码包名、协议及上游归属保留Toonflow标识。许可见[LICENSE](LICENSE)。

[文档目录](docs/readme.md) · [开发指南](docs/development.md) · [当前能力](CAPABILITY-MAP.md) · [验收记录](ACCEPTANCE.md)

## 当前状态

主工作区核心回归与受控页面流程已通过；真实供应商生成、质量、账单及生产交付尚待验收。执行日期和限制见验收记录。具体模型能力取决于适配与明确配置。

## 创作能力

Toonflow 是面向短剧、漫剧与短视频制作的开源 AI 创作平台，把剧本、资产与视频片段整合进同一张无限画布。

| 能力 | 说明 |
| --- | --- |
| 🏠 **本地部署** | 项目与素材保存在自己的设备或服务器，支持桌面、Android、Docker 与服务器部署。 |
| 🖼️ **无限画布** | 在同一画布中组织剧本、角色、场景与视频片段。 |
| 🔌 **MCP** | 通过 MCP 连接外部工具与服务。 |
| 🧩 **插件市场** | 通过[插件市场](https://api.toonflow.net/console/plugIn)扩展节点、工具与创作能力。 |
| 🤖 **开放 Agent** | 开放提示词、工具和 A2A，支持自定义 Agent 行为及外部协作。 |
| 🔧 **自由接入模型** | 配置第三方 API，也可接入本地 ComfyUI 和 LLM。 |
| 🌐 **多语言支持** | 支持 21 种界面语言。 |

### 如何用 Toonflow 制作 AI 短剧与漫剧

1. **编写剧本与分镜**：在文本节点中整理故事、人物设定和镜头描述，使用语言模型辅助创作，再审阅与修改内容。
2. **准备角色与场景素材**：导入参考图片，或通过图片生成节点制作角色、场景和分镜图。
3. **生成视频镜头**：连接文本与图片参考，选择视频模型和生成模式，按镜头生成视频片段。
4. **预览、整理与下载**：在无限画布中预览和组织图片、视频片段，下载素材后按创作需求继续处理。

支持的参考素材、视频时长、分辨率和音频能力取决于所选模型与供应商。

### 常见问题

**Toonflow 可以用于哪些 AI 短剧和漫剧制作环节？**

Toonflow 提供文本、图片与视频生成节点，可用于剧本与分镜创作、角色和场景素材制作、视频镜头生成，以及素材的预览与整理。创作者需要审阅和调整内容，具体生成能力取决于配置的模型。

**Toonflow 免费吗？模型调用需要付费吗？**

Toonflow 采用 MIT 开源许可，可自行部署。第三方模型服务的 API 调用可能收费；使用本地模型或 ComfyUI 时，需要自行准备相应的运行环境与算力。作品示例中的制作费用仅代表该案例，不是固定价格。

**可以接入自己的模型和 ComfyUI 工作流吗？**

可以配置语言模型与媒体模型服务，也可通过自定义供应商适配接入已有的 ComfyUI 工作流。具体接入方式取决于服务 API、模型与工作流，可参考[使用教程](https://qcn7xdsqgc4z.feishu.cn/docx/RXFqdgR2Xo0dXZxGfd0cZCGgnwf)与[开发者文档](https://qcn7xdsqgc4z.feishu.cn/docx/KNBNd9naqolsy6xjAOCcEAkqnRd)。

<a id="languages"></a>

### 多语言支持

支持的语言：简体中文、繁體中文、English、日本語、Русский、Tiếng Việt、ไทย、한국어、हिन्दी、Bahasa Indonesia、Bahasa Melayu、Filipino、বাংলা、اردو、தமிழ்、తెలుగు、मराठी、ਪੰਜਾਬੀ、العربية、فارسی、Türkçe。

---


## 使用与开发

- [源码运行、构建与发布参考](docs/development.md)。
- [MCP接入](packages/mcp/README.md)、[Android说明](apps/mobile/readme.md)、[贡献指南](CONTRIBUTING.md)。
- [恢复说明](docs/dataRecovery.md)、[提交恢复保护](docs/submissionRecovery.md)、[日志容量](docs/activityCapacity.md)。演练结果按记录日期理解。
- [各语言介绍](docs/readme.md)保留上游译版作参考，当前本地状态以本页和验收记录为准。

供应商价格、优惠与服务承诺需向供应商核实，不提供固定生成费用或效果保证。

## 上游及历史资料

[上游仓库](https://github.com/HBAI-Ltd/Toonflow-app) · [许可](LICENSE) · [行为准则](CODE_OF_CONDUCT.md)

旧安装说明、赞助鸣谢、作品示例和发布介绍保留在[README归档](docs/archive/round46/readmeHistory.md)，不作为当前价格、发布状态或验收结论。
