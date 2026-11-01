# P0：配置底座

日期：2026-11-01。状态：开发与自动验证完成；本计划交付底座，后续 GUI 见 [P1](./P1-api-settings.md)。批次：C8.0。范围依据见 [周期定义](../README.md)；问题统一记入 [ISSUES.md](../ISSUES.md)。

## 用户结果与范围

设置可以在模型不可用时独立读写；旧 env 配置继续可用，新 GUI 与手工配置将使用同一份有版本的 `settings.json`。本计划先实现底层及类型化 IPC，不交付设置页面，也不在任务中热替换 provider。

## 设计决定

- Node 配置模块负责唯一的 schema、优先级、校验、原子保存与安全投影。增加独立设置控制进程，复用现有 Node / runtime 资源定位，不为读设置创建 agent、会话或 MCP 进程。
- 优先级为显式环境 > 用户 settings > 最近的旧 env 文件 > 内建默认；保留旧 env 的查找和凭据语义。界面能读到字段来源、文件 revision 与运行时实际采用的 revision。
- v1 只接受 provider、model、API URL、thinking level、默认 workspace 与 MCP 路径等普通设置，拒绝未知字段与明文凭据；凭据当前仍从环境 / 旧 env 读取，仅投影是否配置及来源。
- 用户路径采用现有 Aside 配置目录；支持显式绝对路径覆盖便于测试和恢复。保存校验 schema、检查读取时 revision、临时文件同步后替换，不覆盖无效配置或已改变的文件。
- 迁移旧普通设置不复制密钥、不删除旧文件；固定原 MCP 文件路径，避免迁移配置来源导致 MCP 消失。
- 运行时收到固定配置快照并报告 revision；原生层返回尚未启动 / 启动中 / 已载入 / 待载入 / 不可用。`loaded` 只表示配置快照已读取，不表示连接通过或保留字段已实现；`runtime_fields` 列出目前接通的字段。真正的空闲重建入口随 P1 实现。
- GUI 凭据编辑归 P1：Windows 使用原生凭据管理器，普通 JSON 不保存 key；不增加跨平台密钥依赖。P0 不新增密钥存储入口，也不承诺已有跨平台凭据管理。

## 执行顺序

1. 定义 schema、路径、revision、字段来源、安全错误和 IPC 数据结构。
2. 实现独立的读取 / 保存 / 导入服务与控制入口；补有实际失败条件的回归。
3. 将有效配置接入现有 agent、会话根路径及 MCP 路径，保证一次初始化使用同一快照。
4. 接入 Tauri 设置命令与前端 client，记录实际应用版本；不启动设置界面开发。
5. 验证配置、会话、MCP、协议与原生编译；同步问题和证据后关闭此批。

## 验收与验证

- 没有 key 或 provider 初始化失败时仍可读写配置；读取设置不调用 provider。
- 有效值与来源遵守优先级；显式清除的值不被旧 env 重新填回。
- 无效 schema / URL / 路径、明文 key、旧 revision 和写入失败不破坏原文件；临时文件不残留。
- 导入不包含密钥，MCP 文件路径稳定，已有 env 用户继续启动。
- 设置修改不改变活动 agent；应用状态由 runtime 回报决定，重启后新配置可用。
- 回归范围：新增 settings 测试、既有 config/session/protocol/MCP 定向测试；通过后运行 runtime 总门禁、TypeScript、前端与 Rust 相关检查。fixture 只证明开发行为。

## 执行记录

- 2026-11-01：已核对当前配置与原生进程生命周期；发现会话创建未透传配置参数，登记为 C8-I002，纳入本计划修复。
- 完成 `settings-schema/store/service/control.mjs`；Node 复用唯一配置逻辑，独立控制进程可在 provider 无效时工作。Tauri 暴露三个设置命令，React client 与类型已接通，尚未新增设置页面。
- 配置按一次快照用于 agent / session / MCP，env 中的 session root 可用；普通设置导入不复制 key、不删除原文件，并保留 MCP 位置。旧 cwd 的 MCP 文件仍兼容，新用户默认落在配置目录。
- 原生层记录实际 ready revision，拒绝旧 generation 影响新状态；初始化失败仍能返回可恢复错误。运行中的 agent 不因保存设置改变。
- 验证工作区：基于 `ea4db29` 的本次未提交修改。`npm.cmd run runtime:test` 最终 417/417，通过的 23 项新 settings 测试已纳入总门禁；配置隔离、大小保护和 MCP 路径复查后的最终运行耗时约 8.3 秒。
- `cargo test --lib --offline`：51/51，通过配置状态、失效 generation、初始化失败、独立控制进程大于管道缓存的实际往返等回归。`rustfmt --edition 2021 --config skip_children=true` 已应用于涉及的原生文件。
- `npm.cmd run frontend:test`：24/24；`npm.cmd run typecheck` 与 `npm.cmd run build` 通过。没有新增 UI，前端结果证明原界面未因 IPC 类型接入回退。
- 最初 Cargo / Vite 因沙箱拒绝缓存写入而未启动，授权重跑通过；未发生需修复的断言失败。独立 helper 验证包含真实 Node 子进程，但没有测试真实 provider、用户凭据库、安装包或桌面唤起。
- `thinking_level` / `workspace_root` 目前是预留字段；P2/P3 未执行。凭据 GUI、系统存储和空闲 runtime 重建留在 P1，不用 P0 完成标记代替这些功能。
