# P4：会话管理

日期：2026-11-01 拟稿；2026-11-03 补全为可执行计划。状态：开发与自动验证完成，依赖 P0 / P1 的安全 runtime 生命周期与 P3 的每任务重解析。批次：C8.2。问题见 [ISSUES.md](../ISSUES.md)。

## 范围与用户结果

用户能在界面里新建会话、看到命名过的会话列表、切换、重命名和删除；重启 Aside 后仍能找回。历史只恢复可续接的对话文本与必要配置，不恢复旧权限、旧桌面快照或旧 capture。

不做：全文检索、导出、分支、并行任务、跨盘迁移历史根、自动迁移旧会话。

## 现有实现与新约束

| 事实 | 位置 | 对 P4 的影响 |
| --- | --- | --- |
| 只有一个“最近修改”的 Aside 会话会被打开 | [session.mjs](../../../agent-runtime/src/session.mjs) 的 `openAsideSession` | 需要显式的目标选择，而不是按时间挑最近 |
| 会话按 `cwd` 分目录，Aside 固定用 `<root>/aside-session` | `openAsideSession` + Pi 的 `jsonlSessionDirectoryName` | 列表查询要传同一个 `cwd`，否则看到的是别的工具的会话 |
| JSONL 头部存 `metadata`，名字是追加的 `fact: "name"` mutation | Pi `jsonl/storage.ts` 的 `setName` | 改名是追加一行，不改头部；**列表拿名字必须读整个文件** |
| 会话实体本身无身份校验，重开即用 | `JsonlSessionRepo.open` | 切换必须校验 `application` / `schemaVersion`，拒绝别的 Aside 版本 |
| 重建会保留当前会话、消息和持久化游标 | `createAsideConversationRuntime` 的 `previousRuntime` 分支 | 切换会话**不能**走这条分支，必须显式打开另一个会话 |
| `apply_settings` 是唯一的空闲重建入口 | `protocol.mjs` | 会话切换需要自己的请求类型，不能复用设置重建 |
| 前端 `history_restored` 只处理一次 | [App.tsx](../../../src/App.tsx) 的 `historyHydratedRef` | 切换会话后必须允许重新水合，且不能把旧会话的消息留下来 |
| 任务与持久化在 `onRunSettled` 之后才落盘 | `runtime.mjs` / `protocol.mjs` 的 `operations` 集合 | 切换前要等在途任务与落盘完成，不能让旧 generation 的事件混进新会话 |
| 会话目录是受保护路径 | `config.mjs` 的 `protectedWorkspacePaths` | 历史目录不能被工具当作 workspace 读取或写入 |

## 实现决策

1. **会话身份与命名走 Pi 现有能力，不新建索引文件。**
   列表用 `repository.list({ cwd: join(root, "aside-session") })` 过滤 Aside 元数据；名字用 `session.getName()`。因为名字存在 mutation 里，列表要为每个候选打开一次会话——候选数量是用户在界面里管理的量级，不做缓存；如果以后出现上千个会话再单独优化，不在本批引入第二套存储。

2. **新增协议请求 `switch_session` / `create_session` / `rename_session` / `delete_session`，由协议层排队到空闲。**
   与 `apply_settings` 一样加入 `operations` 集合：任务运行时先结束或取消当前任务，等持久化完成再切换。切换期间到达的 `prompt` 返回可重试失败，与“应用配置中”的现有措辞一致。

3. **切换 = 重建 runtime，但用显式的目标会话。**
   扩展 `createAsideConversationRuntime` 接受 `sessionTarget`：`{ mode: "new" }` 或 `{ mode: "open", id }`。`previousRuntime` 分支只用于同会话重建（设置应用），`sessionTarget` 分支必须重新 `openAsideSession` 并重建 agent，避免把旧会话的 `persistRun`、continuation 和权限带过去。

4. **切换与恢复的清理规则是“全部重置”，不是“尽量保留”。**
   - 旧 `PermissionBroker` 的待决请求全部取消（复用现有 dispose 路径），历史不授予旧权限；
   - `continuation`（selectedWorkspace / previousWorkspace / activeSkillName）不跨会话继承；workspace 在下一次任务按设置重新解析；
   - capture 附件与来源是请求级数据，切换后前端清空，不写入会话；
   - 删除只删选定的 JSONL 文件，不移动、不清理来源与产物。

5. **失败不落到半完成状态。**
   目标会话打不开、不是 Aside 会话、删除失败或持久化失败时，保留当前 runtime 与会话，报告可读错误；新会话创建失败时不动现有会话。删除当前活动会话时先切到一个新会话，再删旧文件——两步都成功才算完成，否则保留活动会话不动。

6. **删除的边界。**
   只删除选定的会话文件。不做“清空历史”、不删 `sessions` 根、不跟随 symlink 删除目标；路径必须来自 `repository.list` 返回的元数据，不接受前端传入的任意路径。

7. **前端入口复用现有呼出界面。**
   在侧栏顶部增加会话入口，打开轻量列表（名称、最后修改时间、当前标记）；新建、切换、重命名、删除都在同一处。沿用现有宽度、圆角与按钮规范，不重做聊天区域。删除与切换在任务运行时禁用并说明原因。

8. **切换后前端状态重置。**
   `history_restored` 改为可重复处理：切换成功后清空消息、草稿、附件、权限卡、工具活动、验证状态和错误，再按新会话的消息水合。旧会话的迟到事件用现有 generation/sink 机制隔离。

## 验证计划

必须先失败再修复，按现有测试风格补回归：

- **repository / 会话层**：列表只返回 Aside 会话；名字写入后可读回；非 Aside 元数据被拒绝；损坏会话不阻断其它会话的列表与打开。
- **切换**：两个命名会话反复切换，消息互不串；切换时在途任务先完成落盘；切换期间 `prompt` 返回可重试失败；切换后旧权限卡与新会话无关；workspace 不跨会话继承。
- **新建**：新建后是空会话，旧会话文件仍在；创建失败保留当前会话。
- **重命名 / 删除**：改名落盘并出现在列表；删除只移除选定文件，来源与产物不受影响；删除当前会话先切新会话，失败时不删。
- **重启恢复**：重建进程后能按名字找回两个会话并打开指定那个。
- **前端**：列表渲染、当前标记、任务运行时禁用、切换后消息与附件的清理。

门禁沿用整轮要求：runtime、前端、Rust、类型检查与生产构建；真实桌面与非厂商路径仍单独标为未验证。

## 验收边界

至少两个命名会话可反复切换且重启后仍可找回；同一时刻只有一个活动会话，失败不切到半完成状态；历史文本恢复不等于恢复桌面快照。真实窗口、安装包与人工验收继续延期，不用本批的自动证据替代。

## 执行记录

实现与计划一致，以下为落地细节与计划外的发现。

**仓库层**（`session.mjs`）：`createAsideSessionStore` 统一构造 root / cwd / repository，`listAsideSessions`、`openAsideSessionById`、`createAsideSession`、`deleteAsideSession`、`renameAsideSession` 共用它，避免列表与活动会话看向不同目录。会话 id 走 `ASIDE_SESSION_ID` 白名单校验；名字上限 120 字符，空白名字视为清除。删除只使用列表返回的元数据里的路径，不接受前端传路径。

**运行时切换**：`createAsideConversationRuntime` 增加 `sessionTarget`（`{ mode: "new" }` / `{ mode: "open", id }`）。它与 `previousRuntime` 互斥——后者是同会话重建，会带着旧持久化游标、continuation 和权限；切换必须走前者。`continuation` 在切换时显式置空。

**协议层**：新增 `list_sessions` / `switch_session` / `rename_session` / `delete_session`，统一进入一个串行队列，并在执行前等待所有在途 prompt / workspace 操作结束。`switch_session` 的 `create` 分支先建会话再替换；`delete_session` 删除当前会话时先切到新会话。切换期间到达的 prompt 返回可重试失败。

**前端**：新增 `SessionPanel`，列出名称、修改时间与当前标记，支持新建 / 打开 / 重命名 / 删除；删除需二次确认并说明不删文件。`history_restored` 增加 `replaced`，切换时清空草稿、附件、capture、权限卡、工具活动与验证状态后再水合。任务运行时禁用切换与删除。

## 保留限制与下一步

- 列表为每个会话打开一次文件读取名字（名字存在 mutation 而非头部）；当前量级可接受，未做索引缓存。
- 未做会话搜索、导出、分支、并行任务与历史根迁移。
- 真实桌面面板交互、安装包内路径与真实 MCP / 权限在切换时的表现未验证。
- 下一个功能按 [P5](./P5-mcp-settings.md) 实施 MCP 配置 GUI。
