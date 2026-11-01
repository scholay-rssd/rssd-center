# RSSD Center

RSSD 的内容中心，基于 **Postiz v2.25.1** 扩展需求池、多语言作品库、文章编辑、设备协调与发布记录，并保留 Postiz 的认证和发布集成。

**完整项目介绍、资源准备、写作流程与十站 Demo，请从 [RSSD 主仓](https://github.com/scholay-rssd/rssd) 开始。**

## 使用与开发

- [RSSD 架构、接口、部署与验证](rssd/README.md)：中心界面、设备凭据、迁移与发布回读。
- [Postiz 原始文档](README.postiz.md)：上游服务与运行环境。
- [桌面与 Linux 设备授权](https://github.com/scholay-rssd/rssd/blob/main/docs/center-login.md)：账号连接、工作空间范围与恢复。

中心独立构建，使用 Node.js 22.19、pnpm 10.6.1 及本仓库锁文件。在组合工作区中位于 `center/`。

作品库、认领协议、范围凭据、编辑器和持久提交已实现并有测试覆盖。目的地派发、站点迁移及最终生产验收分别跟踪；进入队列与公开发布是不同状态。RSSD CI 使用合成数据和隔离 PostgreSQL，上游工作流在 `rssd/upstream-workflows/` 留作非活动参考。

## 许可

本仓库是 Postiz 的 [AGPL-3.0](LICENSE) 派生项目，保留上游与第三方声明。来自 RSSD 核心的协议依赖使用独立 [MIT 许可](rssd/PROTOCOL-LICENSE)，来源由 `rssd/protocol.source.json` 记录。
