# P6：独立验收后的会话可靠性收口

日期：2026-11-08。P6 是功能批次编号，不是问题严重度。仅修独立验收发现的 1 项 P0、3 项 P1，不扩展 Cycle 8 或未来 release 范围。

## 执行顺序

1. C8-I031：活动会话改名使用当前写实例，防止 JSONL 序号重复；覆盖改名后续聊、重开和列表。
2. C8-I032：新建 / 切换传入隔离的事件出口，候选提交后才转发；覆盖流式、终态、审批与失败候选 / 旧实例事件隔离。
3. C8-I033：设置应用与会话操作共用互斥边界；覆盖两个竞态方向、失败后恢复、在途任务与取消。
4. C8-I034：替换前重试保存当前内存历史；持续失败时保留旧实例，恢复后完整保存，覆盖部分写入和活动会话删除。
5. 先跑专项失败回归，再跑 runtime、前端、Rust、类型和构建门禁；记录实际结果，不以自动化替代真实桌面 / 厂商验收。

## 边界

- 每项先有回归再修复，问题记录集中在 [ISSUES](../ISSUES.md)。
- 不修改 vendored Pi，不放宽序号 / 审批校验，不自动改写既有损坏历史。
- C8-I035–I040（P2）明确延期，留待 release 范围与成熟开源 harness 对比时处理；不顺带修前端、MCP 编辑或删除事务回滚。
- v1 / V1.6 不属于本轮验收范围；本轮不创建提交。

## 验证记录

2026-11-08 已按上述范围完成，改动留在工作区，未创建提交。正式回归加入 `agent-runtime/test/protocol.test.mjs`，由既有 `runtime:test` 门禁覆盖，没有引入新工具或配置项。

### 实现与专项证据

- 活动会话改名向 helper 传入当前 session，并验证 id 一致；名称仍走原校验，非活动会话继续按 id 打开。改名后两轮对话的全部历史可重开且列表正常。
- 新建 / 切换的候选拥有独立 sink；先提交 history 与 session_switched，再放行 ready 等缓冲事件。真实 Pi-backed runtime + 本地 faux provider 覆盖新建及重开后的流式 / completed、实际 permission broker 的请求与响应，以及旧 sink / 失败候选隔离。
- 会话操作在加入 operations 前等待 applying 的 Promise，避免自等；原 apply 仍等 operations 清空。两个重建方向、apply / switch 各自失败后的排队恢复均有回归；排队期间真实流式任务仍能取消。
- runtime 暴露内部 flushPersistence，在切换 / apply / 活动删除前重试当前 transcript。持续失败不构建候选、不新建会话、不删除历史；恢复后续写。覆盖首条成功后第二条失败的去重、全部写入失败后的首次替换恢复、apply 后继续聊天和保存等待期间拒绝新 prompt（审批响应仍可通过）。

### 失败过程

- 首轮专项 9 项：2 通过、7 明确失败，覆盖四项产品缺陷。更早一次测试的预期事件永不到达导致后续项被取消，已改为有界等待与同时断言成功 / 失败结果，未把取消记为复现通过。
- 产品修复后首轮三文件专项 46/50：4 项断言差异来自内存消息含 undefined 字段，而 JSONL 本就不序列化这些字段。修正为按 JSON 序列化语义比较完整消息后 50/50；没有放宽产品持久化契约。
- 随后新增 5 项恢复 / 队列边界测试，最终本轮增加 14 项。Vite 临时文件及 Cargo 构建锁曾被沙箱拒绝，获准重跑后门禁通过；这些环境错误不计为产品缺陷。

### 最终门禁

| 命令 | 实际结果 |
| --- | --- |
| `npm.cmd run runtime:test` | **511/511**，原 497 + 本轮 14 |
| `npm.cmd run frontend:test` | **63/63**，4 文件 |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline` | **57/57** |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run build` | 通过 |
| `git diff --check` | 通过 |

独立审计和本轮日志保留在本地 `.cache/c8-independent-audit/`，分别使用 `p6-red.log`、`p6-targeted.log`、`p6-runtime-full.log`、`p6-frontend-full.log`、`p6-rust-full.log`、`p6-build-full.log`。未调用真实厂商、未做真实桌面 / 安装包联合验收；自动回归不替代这些延期项。六组 P2 仍未修复，见 C8-I035–I040。
