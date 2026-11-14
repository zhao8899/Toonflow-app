# 当前验收与证据索引

更新：2026-11-14。本次仅整理文档，未重跑业务测试；下表保留原执行日期与范围。

| 日期/轮次 | 对象与结果 | 证据 |
| --- | --- | --- |
| 11-13 / 44 | 主工作区146通过、0失败、966父断言、12文件、57.05秒，含独立Chrome | [日志](recovery/mainCoreRound44.log) |
| 11-14 / 45 | 登录、项目创建/导入、受控模型选择、任务查看、视频播放下载、人工费用保存重读导出通过 | [记录](recovery/userFlowRound45/summary.md)、[费用导出](recovery/userFlowRound45/costExport.json)、[页面](recovery/userFlowRound45/costRecord.png) |
| 11-14 / 45 | 主项目Web构建通过，未改业务代码 | [日志](recovery/webBuildRound45.log) |
| 11-13 / 43 | Pi独立副本147通过、0失败，类型/构建/独立审查完成；未回迁 | [副本日志](recovery/piMigrationRound43/recovery/finalIntegrationRound43.log)、[隔离核对](recovery/piMigrationRound43/recovery/isolationRound43.json) |

日期均为2026年。第45轮为4秒320×180受控样片，下载SHA256与源样片一致：2c908e32a2026d294f6c30ec52eabcda9e38f229bda7f71e239d334b6441b0e1。0.125 CNY为人工测试记录，不是真实扣费。模型及任务由隔离环境准备，不证明真实生成。

第44轮首次命令误扫描副本并有HTTP超时一次；定向及明确路径全量复跑通过，失败日志保留，未放宽测试或修改业务。命令使用明确路径：bun test ./apps/server/tests ./apps/web/tests。

真实供应商质量/账单、全部平台、真实历史库迁移和生产升级回滚仍未验证。恢复脚本替身不等于Docker实测。recovery证据在本地忽略目录，缺少文件时应标作证据不可取得。

[完整历史归档](docs/archive/round46/acceptanceHistory.md)。旧版本、环境和计划只对应当时，不代表当前状态。
