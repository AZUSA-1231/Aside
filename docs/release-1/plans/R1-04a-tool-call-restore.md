# R1-04a：工具调用关联与有界恢复投影

日期：2026-11-17。里程碑 1 / M08；对应验收 I3 的记录底座（完整展现归 04b）、F9 恢复完整性。状态：**开发完成，自动门禁通过，未提交；实机未执行**。当前 WIP 只在 [RECOVERY-PLAN](../../RECOVERY-PLAN.md#2026-11-09-release-1-当前执行表)维护。

## 1. 用户结果与停止线

重开一个旧会话时，能看到那次任务里实际调用过哪些工具、各自成败与来源，而不是只剩两段对话文字。这**不是**新功能的数据采集：这些记录已经存下来了，缺的是把它们投影出来。

停止线：一次含多个工具调用的任务，重开会话后仍能按调用次数与顺序看到结果，状态不假报成功，失败与截断如实标注；恢复量有界，长会话不会因投影而变慢或超限。完整时间线交互（逐次展开、参数/结果详情面板）留给 04b。

## 2. 已核对的现状与根因

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| assistant 消息的 `content` 里**已经**存了 `ToolCall`（含 `id` / `name` / `arguments`），`toolResult` 消息**已经**存了 `toolCallId` / `toolName` / `content` / `details` / `isError` | `vendor/pi` 的 `AssistantMessage` / `ToolResultMessage`；`session.mjs` 的 `durableMessage` 只去掉 `undefined` | 数据齐备，不需要新增存储层 |
| `restoreAsideSession` 只把「有文本的 user / assistant」放进 `history`；`toolResult` 完全不投影，纯工具调用的 assistant 帧被跳过 | `agent-runtime/src/session.mjs:456-486` | 重开后工具轨迹彻底消失 |
| `request_id` **未持久化** | `session.mjs` 无对应字段 | 不能按"运行"分组恢复；只能按消息位置配对 |
| `details` 在落盘前已被 `boundedToolResult` 限制（单条 8 KB，预览 2 KB） | `capability-result.mjs:37-38`、`:120-129` | 单条有界，但**总条数无界** |
| MCP 工具名强制为 `mcp.<server>.<tool>.<digest>`，内建工具不可用该前缀 | `capability-contract.mjs:431-444`、`:115-125` 的 `assertToolNamespace` | 「来源」在恢复时可以**从强制命名空间判定**，不是猜测 |

根因单一：读得回来，但没投影出来。

## 3. 输入 / 输出与契约

**输入**：已存在的会话 JSONL。不新增文件、不新增日志库、不改 vendored Pi。

**输出**：`history_restored` 的每条消息可携带该轮的工具调用列表；前端在重建历史时保留它们。

关联规则（最小、不新增字段）：

- 一次工具调用 = assistant 消息中的 `ToolCall` 与其后 `toolResult` 按 `toolCallId` 配对。`toolCallId` 已持久化，不需要引入 run id。
- 调用归属到包含该 `ToolCall` 的 assistant 消息；`toolResult` 不单独成条，作为调用的结果字段。
- 找不到对应 `toolResult` 的调用（任务中断、保存失败）标为 `unknown`，**不推断为成功**。
- 找不到对应 `ToolCall` 的孤立 `toolResult` 不投影（它在对话里没有可见位置），但在测试里要求不导致崩溃。

来源判定：`toolName` 以 `mcp.` 开头即为 `user_mcp`，否则 `builtin`。这是契约强制的互斥命名空间，因此是判定而非猜测；注释里要写明依据，避免日后被当成启发式。

有界投影：

- 每条结果的文本按现有预览上限截断（2 KB），标 `truncated`。
- 每次恢复的工具调用**总条数**与**总字节**都设上限，超出时保留最近的部分，并在恢复结果里带一个明确的「更早的调用未显示」计数——不静默丢弃。
- 上限取常数并写进测试，不按会话长度动态放宽。

不做：不新增持久化字段（`request_id`、run 分组、产物路径关联留给 06a）；不改 `toolResult` 落盘形状；不做逐次展开 / 参数详情 / 时间线 UI（04b）；不记录工具输入正文之外的任何内容。

## 4. 分步实施，串行完成

1. **恢复侧配对与投影**：在 `restoreAsideSession` 中把 assistant 的 `ToolCall` 与后续 `toolResult` 配对，生成有界列表；`messages`（agent 转录）保持不变，只改 `history` 投影。
2. **契约字段**：`RuntimeHistoryMessage` 增加可选的工具列表；字段可缺省，旧前端 / 旧会话不因缺字段而失败。
3. **最小展示**：重建历史时按调用顺序显示工具名、状态、来源与截断标记，复用现有状态文案。不新增展开面板。
4. **回归与证据**：覆盖多工具、失败、截断、孤立结果、超界、旧会话兼容。更新执行表与 issue。

## 5. 失败语义

- 会话文件损坏或某条消息形状不合法：沿用现有 `session_warning` 路径，不因投影失败而阻止打开会话。
- 配对失败或结果缺失：状态为 `unknown`，不写成 `succeeded`。
- 超界截断：保留最近部分并报告未显示数量，不静默丢弃，也不谎称完整。
- 恢复不改写文件：重开是只读投影，不触发保存、不产生新旧格式混写。
- 旧会话（无工具数据可用）按现状恢复，不报错、不提示「数据缺失」。

## 6. 自动完成条件

| 检查 | 必须证明 |
| --- | --- |
| 多工具关联 | 一轮内 3 次调用按顺序恢复，各自的 `toolCallId` 不与彼此或上一轮串号 |
| 状态保真 | 成功 / 失败 / 取消分别恢复为对应状态；缺 `toolResult` 的调用为 `unknown` |
| 来源 | `mcp.*` 恢复为 `user_mcp`，其余为 `builtin`；与运行期 `provenanceFrom` 结论一致 |
| 有界 | 超条数 / 超字节的上限用例：保留最近部分并给出未显示计数；单条文本截断带标记 |
| 不串会话 | 切换到另一个会话后，不会显示上一会话的工具列表 |
| 只读 | 重开前后文件内容逐字节不变；不产生新的写入 |
| 兼容 | 无工具字段的旧历史仍能恢复；契约可缺省 |

从定向测试开始，再运行根 `typecheck`、`runtime:test`、`frontend:test`、`build`，以及 `cargo test --manifest-path src-tauri/Cargo.toml`。新测试进入正式脚本。

## 7. 不在本任务完成的验收

I3 的完整交互（逐次展开、来源与参数预览的完整呈现）归 04b；产物路径与打开入口归 06a；真实桌面与安装包验收归发布收口。任务结束时写清改动文件、门禁、未执行项、限制与对应 issue；不自动 commit / push，不开始 06a。

## 8. 实现记录（2026-11-19）

**改动文件**

- `agent-runtime/src/session.mjs`：新增 `restoreToolCalls`，按 `toolCallId` 配对并做有界投影；`restoreAsideSession` 返回 `hiddenToolCalls`；导出 `MAX_RESTORED_TOOL_CALLS`（50）与 `MAX_RESTORED_TOOL_BYTES`（16 KiB）。
- `agent-runtime/src/protocol.mjs`：三处 `history_restored` 事件带 `hidden_tool_calls`。
- `src/lib/contracts.ts`：新增 `RuntimeHistoryToolCall`，`RuntimeHistoryMessage.tools?`，事件上的 `hidden_tool_calls?`。
- `src/App.tsx`：`ChatMessage.tools`，`toChatMessage` 保留调用，渲染恢复调用列表与「更早调用未显示」计数，切换会话时清零。
- `src/App.css`：恢复调用列表样式，独立于运行期工具卡。
- 测试：新增 `agent-runtime/test/session-tool-restore.test.mjs`（9 项）与 3 项前端回归；`session.test.mjs` 的隐私用例更新为新的投影结果。

**实现时确认的行为**

- 纯工具调用的 assistant 帧**现在进入**历史投影（文本为空，由调用列表承载）。之前它被整体跳过，这正是「重开只剩对话文字」的直接原因。该帧不是气泡，不会出现空消息。
- `unknown` 状态用于「调用有记录、结果没有」，与既有状态词汇共存，不新增落盘字段。
- 单条文本按 `MAX_TOOL_PREVIEW_BYTES`（2 KB）截断；总量按条数与字节双上限约束，从最新往回保留。
- 来源由 `toolNamespace` 取首个命名空间段判定，而不是 `includes("mcp.")`；测试覆盖了「后段看起来像命名空间」的反例。

**门禁**：`runtime:test` 538/538（新增 9 项）、`frontend:test` 73/73（新增 3 项）、`cargo test` 57/57、`typecheck`、`build` 通过。

**已知限制**

- 未做真实桌面重开与长会话耗时测量；I3 的完整体验（逐次展开、完整参数预览）归 04b。
- 恢复按消息顺序与 `toolCallId` 配对，不按运行分组（`request_id` 未持久化）；跨轮同名调用的分组差异在 04b 需要时再议。
- 旧会话没有工具记录，按现状恢复，不提示「数据缺失」。
