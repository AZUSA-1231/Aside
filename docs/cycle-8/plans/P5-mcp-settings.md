# P5：MCP 配置界面

日期：2026-11-01 拟稿；2026-11-04 补全为可执行计划。状态：开发与自动验证完成。依赖 P0、P1 与 P4 的会话生命周期。批次：C8.3。问题见 [ISSUES.md](../ISSUES.md)。

## 范围与用户结果

用户可在界面管理现有 stdio MCP 服务，理解已配置、启用、信任、连接和分类状态；错误不会阻断其他服务或普通文件任务。

## 入口位置（2026-11-03 用户决定）

MCP 配置作为 **Settings 面板内的一个分区**，不新增独立入口，也不占用侧栏按钮。
现有设置卡片（Provider / Thinking / Default directory / API key / Apply and test）
继续排列，MCP 分区跟在后面。

这与 Cycle 8 最初的分页设想一致（“模型与 API / 文件与存储 / MCP / 诊断”）。由此：

- P5 **不被**“设置是否改成独立临时窗口”的方案阻塞。窗口若以后实施，整个 Settings
  一起搬，MCP 分区随之进入；若不实施，它就只是面板里的另一组卡片。
- 不新增 `#/mcp` 路由或多个面板切换状态，避免在窗口方案未定时先造第二套导航。
- 会话列表保持独立入口（P4 已作为独立面板），因为它属于对话流程而非配置。

## 计划

1. 复用现有 mcp.json schema、位置与配置验证，增加独立读写 / revision 冲突处理，不复制一套服务定义到 settings。
2. 提供新增、编辑、删除、启用和信任入口；Windows 保留直接可执行程序限制。
3. 通过凭据引用编辑环境变量，不把明文 key 写入 mcp.json；只在用户触发测试时启动服务。
4. 显示连接结果、工具发现、现有双绑定分类与失效原因；启用、信任和逐次执行批准保持分离。
5. 空闲时清理旧连接并应用修改；变更后的旧分类不能自动继续有效。

## 现有实现与约束

| 事实 | 位置 | 对 P5 的影响 |
| --- | --- | --- |
| 只有读取路径，**没有任何写入 `mcp.json` 的代码** | `mcp-runtime.mjs` 的 `loadMcpServerConfigs` | 写入、原子替换与 revision 冲突处理都要新建 |
| 校验规则很严：id 小写且仅 `[a-z0-9_-]`、`env` 只接受 `{ from_config }`、Windows 命令必须是 `.exe` / `.com` | `mcp-config.mjs` | GUI 必须直接呈现这些拒绝原因，不能放宽 |
| 文件级失败不致命，单服务失败只影响该服务 | `loadMcpServerConfigs` 逐条 try/catch | GUI 的列表要能显示“这条坏了但文件还能读” |
| `enabled` 与 `trust_acknowledged` 是两个独立布尔 | `validateServerConfig` | 界面必须分别呈现，启用不等于信任 |
| 分类带 `schema_digest` / `server_fingerprint` 双绑定 | `mcp-config.mjs` | 命令或环境变更后旧分类失效，界面要说明原因 |
| 连接与工具发现只在真实任务内发生 | `McpController.tools()` | “测试连接”需要独立的、一次性的控制器实例 |
| 运行中的 MCP 连接由空闲重建关闭并重读 | `protocol.mjs` 的 `apply_settings` | MCP 变更复用同一重建通道即可，不新增第二条 |
| `mcp_config_path` 已是受保护路径 | `config.mjs` 的 `protectedWorkspacePaths` | 工具无法把配置当 workspace 读写 |

## 实现决策

1. **写入走新的 `mcp-store.mjs`，与 settings-store 同构。**
   读 → 校验 → 原子写（临时文件 + rename）→ revision 冲突检测。revision 用文件内容的 sha256；
   前端保存时带上读到的 revision，外部改动导致不匹配时拒绝并提示重载，与设置文件的行为一致。
   文件保持 `{ "servers": [...] }` 形状；空列表不删除文件，避免把“没有服务”和“路径丢失”混为一谈。

2. **保存的是原始条目，不是运行时的规范化结果。**
   `validateServerConfig` 会补默认值、算 fingerprint、冻结对象。写回文件时用原始形状，
   避免把派生字段（`fingerprint`）写进用户文件、让下次读取显得“外部被改过”。
   校验在保存前跑一次并返回具体字段错误；**不合法则不写**。

3. **`trust_acknowledged` 只由用户明确点击设置。**
   GUI 保存时该字段原样传递，不因“新增服务器”自动置 true。新增的服务默认
   `enabled: true`（用户填了就是想用）但 `trust_acknowledged: false`（尚未确认这是本机执行的第三方代码），
   卡片上必须显示“已配置、尚未信任，不会启动”。

4. **“测试连接”是独立的一次性动作。**
   用 `McpController` + 该服务单条配置跑一次 `tools()`，收集工具列表与诊断，随后立即 `close()`。
   它不修改文件、不注册工具、不影响运行中的会话，也不写入任何缓存。结果区分三种：
   进程起不来（含 stderr 摘要）、起来了但工具全被 schema 策略拒绝、正常列出 N 个工具。
   测试需要用户已配置所需环境变量；缺失时报告缺哪个名字，不报告值。

5. **应用变更复用空闲重建。**
   保存 MCP 后不立即重启，与设置一致：状态置为 pending，由“Apply when idle”触发
   `apply_settings`，重建时重新读 `mcp.json` 并关闭旧连接。运行中的任务保持旧连接直到结束。
   界面同样显示 saved / pending / applied 三种状态。

6. **分类的失效原因要可读。**
   工具卡显示当前分类与来源（用户分类 / 保守默认），当 `server_fingerprint` 或
   `schema_digest` 与当前服务不符时，标为“配置已变更，分类已失效”，并提供清除入口；
   不提供“一键全部信任”。

7. **环境变量编辑只接受名字 → 配置名。**
   界面上每一行是 `ENV_NAME = <从 Aside 配置读取的名字>`；输入框只收变量名，另一侧只收
   `from_config` 名。任何看起来像密钥的值都会被现有校验按 `mcp_secret_must_be_indirect` 拒绝，
   界面直接展示该错误。

## 验证计划

- **store**：写入后原样读回；非法条目拒绝且文件不变；revision 冲突拒绝；空列表保留文件；
  临时文件不残留；并发保存只有一个成功。
- **协议 / 运行时**：保存后 pending，apply 后重建并重读；运行中任务不受影响；
  被禁用的服务不启动；未信任的服务不启动；命令变更后旧分类复核为失效。
- **连接测试**：正常服务列出工具；进程失败有可读错误；环境变量缺失点名不点值；
  超时与取消可复现；测试不影响运行中的会话。
- **前端**：增删改表单校验错误直出；启用 / 信任分列显示；测试结果三态区分；
  保存后阻塞 Apply；某张卡片失败不影响其他卡片。
- **不泄露**：所有诊断与错误串里不出现配置值，只出现变量名。

## 验收边界

能通过 GUI 配置一个已有支持的 stdio 服务，错误、超时、取消、配置冲突与停止都可恢复；导出 / 诊断不泄露环境值。不引入 HTTP、OAuth、服务市场、任意 shell 或完整策略编辑器。

MCP 分区与既有设置卡片共用一个滚动区域，因此还要满足：卡片增多后窄面板仍可读到全部内容；MCP 的保存 / 应用与 Provider 的保存 / 应用互不误触发；某张卡片的失败不影响其他卡片的可读状态。

## 执行记录

按计划实现，另有一处计划外发现。

**新增模块**

- `agent-runtime/src/mcp-store.mjs`：读写 `mcp.json`，写入为原子替换（临时文件 + rename），带锁与 revision 冲突检测；保存初再次比对，覆盖“写入临时文件期间被外部修改”。
- `agent-runtime/src/mcp-test.mjs`：一次性连接测试。为单条服务建 `McpController`，跑 `tools()`，在 `finally` 里必定 `close()`。结果为 `ok` / `tools_rejected` / `unreachable` / `missing_environment` / `invalid` 五种。
- `src/McpSettingsCard.tsx`：Settings 内的 MCP 分区，折叠列表 + 新增 / 编辑表单。

**协议与原生**

`handleSettingsRequest` 增加 `get_mcp` / `save_mcp` / `test_mcp` 三个操作，与原设置共享同一控制进程。原生层 `test_mcp` 与 `test_connection` 一样读取真实凭据（解析 `from_config` 需要），`get_mcp` / `save_mcp` 不触碰凭据存储。

**状态按行为命名**

列表里每台服务显示“Active · starts with new tasks”“Enabled, not trusted · will not start”等，直接说明会发生什么，而不是让人对照两个布尔自己推断。新增服务保存为 `enabled: false` + `trust_acknowledged: false`（用户确认的保守默认）。

**计划外发现（C8-I030）**

`effectiveRevision` 原本只由设置值与凭据组成。这意味着改完 MCP 后 revision 不变，设置界面会把 runtime 尚未读取的服务列表报成 `loaded`。已把 `mcp.json` 的内容摘要纳入 revision；文件缺失或不可读不计为变更，交由 MCP loader 自己的诊断报告。

## 验证记录

- 新增 19 项 runtime 回归：文件缺失读为空、保存往返不写派生字段、非法条目拒绝且文件不变、明文密钥被拒、revision 冲突拒绝、重复 id 拒绝、无临时文件残留、坏条目隔离、外层形状兼容、设置服务读写、多余字段拒绝、连接测试五种结果、缺失配置点名不点值、修订号随 MCP 内容变化。
- 新增 8 项前端回归：状态按行为命名、启用与信任独立、新服务默认停用且未信任、缺失配置只显示名字、工具被拒与起不来分开报告、分类失效标记、删除不清程序、文件级诊断可见。
- 变异验证：“启用与信任独立”在改成同时置位后精确失败。
- 门禁：runtime **497/497**、前端 **63/63**、Rust **57/57**、类型检查与生产构建通过。

## 保留限制与下一步

- 真实 MCP 服务进程、真实 Windows 桌面交互与安装包内路径未验证；测试使用的是控制器替身，不是真实子进程。
- 分类只显示与标记失效，未提供在 GUI 内重新分类的编辑器；仍沿用 `mcp.json` 中的显式分类。
- 未做 HTTP / OAuth 传输、服务市场或完整策略编辑器。
- Cycle 8 的 P0–P5 至此全部完成开发验证；真实桌面、厂商连通、Office 人工与发布验收仍整体延期。
