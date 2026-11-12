# R1-01：模型接入闭环

日期：2026-11-09，实现记录 2026-11-10。里程碑 1 / M01、M06；对应验收 B1–B9（B7 为扩展观察）、H1 / H5。状态：**开发完成，自动门禁通过，未提交；真实厂商与实机未执行**。本次未开发其他任务，未创建提交，当前 WIP 只在 [RECOVERY-PLAN](../../RECOVERY-PLAN.md#2026-11-09-release-1-当前执行表)维护。

## 1. 用户结果与停止线

用户在现有 Settings 中配置一个 custom API route，明确协议、Base URL、model id、上下文 / 输出容量与能力，使用独立安全凭据；测试与实际聊天沿用同一条解析路径。不需要编辑配置文件，也不把未知模型冒充 catalog 模型。

只保留一个可配置 custom route，不做多 profile / 多账户、厂商登录、任意网关适配矩阵、原生 CLI 接入或视觉重构。完成下文自动门禁即可关闭本功能的开发阶段；真实厂商与 Windows 凭据 / 发布联合验收仍单独待验。

## 2. 已核对的底座与风险

| 入口 | 现状 / 本任务要接通的地方 |
| --- | --- |
| `agent-runtime/src/settings-schema.mjs` | 仅四家 provider、model / api_url 等白名单；未知字段拒绝。增加能力不能只改 UI，不得顺手忽略未知配置。 |
| `agent-runtime/src/provider-settings.mjs` | 由 providerFactories / catalog 选择模型，未知 model 拒绝；Base URL 覆盖不改变协议，OpenAI 工厂当前绑定 Responses。 |
| `agent-runtime/src/config.mjs`、`settings.mjs` | 环境 / 用户设置 / legacy 的来源与 revision；新增字段必须让有效值、已保存与待应用一致。 |
| `src/lib/settings.ts`、`src/SettingsPanel.tsx` | 四家类型 / 下拉框、model catalog、thinking 与保存 / 测试路径；复用当前入口，不新增设置窗口。 |
| `src-tauri/src/credentials.rs`、`settings.rs` | 原生凭据枚举目前也是四家；custom key 必须端到端支持，不能误借 OpenAI 凭据或写入 settings.json。 |
| `vendor/pi/packages/ai/src/providers/openai.ts`、`types.ts` | 已有 Responses / Completions API 类型与模型容量 / compat 信息；复用 vendored 版本能力，不升级或修改 vendor。 |
| `agent-runtime/src/session.mjs`、`protocol.mjs` | 设置应用与会话操作互斥，替换前 flush，失败保留旧实例；不得因新路由破坏 P6 修复。 |

源码存在不等于自定义模型一定可用。第一段实现先用本地夹具证明模型注册 / API 调度路径可成立；如 vendored API 契约不支持预期做法，先记录 R1-Q001 的具体约束，再选最薄适配，不新写 agent loop。

## 3. 输入 / 输出与配置契约

- 输入：现有四家之一，或单个 custom route。后者包含协议（Chat Completions / Responses）、Base URL、model id、有限正整数的 context window / max output、声明的能力与凭据状态。显示名称可选，不引入命名 Agent。
- model id 不要求存在于 catalog；仍按可接受长度 / 字符与传输要求校验。URL 复用当前 HTTP(S)、不含内嵌凭据 / query / fragment 的边界；不自动尝试另一协议或猜另一厂商。
- 容量由用户明确给出，不编造无限窗口；输出预留须与上下文预算协调。至少声明文本 / tools 与 reasoning 能力，图像未声明就不按支持处理；具体字段名和 schema 兼容写法在实现时一次定义并测试，不扩成能力 DSL。
- thinking 档位只暴露当前协议适配确实能发送的集合；不支持的值明确拒绝或显示 requested / applied 回退，不能静默声称应用成功。未验证厂商扩展不得自动启用。
- custom 凭据与四家凭据独立，使用现有原生安全存储；不得因 custom URL 误发内建厂商 key。设置读回只报告状态，删除 / 替换凭据必须可预测；环境覆盖及来源明示。
- 输出：保存后的有效配置 / 来源 / revision、可用档位、连接测试结果；实际运行使用与测试相同的 resolved model / API 路由。测试成功只证明本次探测，不冒充全部 tools / reasoning 能力验证。
- 旧 schema 文档和四家设置保持可读。若必须升级 schema，应有显式版本识别与无损迁移测试，不能靠放松校验吞掉旧内容。配置与凭据是两个存储，失败明确说明哪一步成功，不宣称天然原子事务。

## 4. 分步实施，串行完成

1. **路由核心与本地证明**：在 Aside 层解析 custom model / API，按现有 Pi 接口注册；用两类 HTTP/SSE 夹具验证聊天、流式工具调用与结果往返、取消 / 失败。不先扩大 schema / GUI 却留下不可执行路线。
2. **设置与原生凭据闭环**：接通文档校验、有效来源、revision、catalog / custom 切换、独立凭据读写 / 删除与 idle apply；回归旧四家和 P6 的替换保护。
3. **现有 GUI 投影**：按 route 显示协议 / model / 容量 / 能力 / thinking；保存、待应用、测试失败与凭据状态可理解。保存失败保留用户输入，不显示假的已应用。
4. **回归与证据**：完成下面测试，更新能力现状、issue 和执行表；产品功能门禁与真实厂商 / 实机待验分别记录。发现非本功能问题只登记，不顺带修复。

## 5. 失败语义

- 无效 URL / 容量 / 能力组合在发请求前拒绝；不把旧有效设置或 runtime 替换掉。
- 认证错误、404 / 协议不匹配、网络超时和畸形 SSE 明确失败，不自动轮询其他协议，不回显密钥、正文或原始响应。
- 运行中保存继续使用当前任务原配置，空闲后安全应用；session switch / new / rename 的排队保护继续有效。
- 持久化 flush、凭据读写、配置 revision 冲突或 runtime 重建失败时保留可用旧状态与可恢复提示，不丢会话、不假报应用成功。
- reasoning / tools 的声明只是配置约束，不是厂商质量保证；探测失败可以修配置重试，不无限重试，不扩大公开支持承诺。

## 6. 自动完成条件

| 检查 | 必须证明 |
| --- | --- |
| 配置兼容 | 旧四家文档 / 环境覆盖、未知字段拒绝、无效容量与协议、custom / catalog 往返保存，失败不破坏旧有效值。 |
| 实际 HTTP 路由 | 两类本地 server 分别接到正确 endpoint / body / model；stream、tool-call/result 往返、取消 / 失败均经过真实 adapter，而不是仅 mock selectProvider。 |
| 能力与 thinking | 未声明能力不误发；支持档位映射和输出上限正确，不支持的 reasoning 有明确结果；缺 usage 不造 0。 |
| 凭据 / 安全 | custom 与内建 key 不混用；原生 allowlist 和读写 / 删除 / 错误路径有定向测试；前端快照与诊断不含明文 key。 |
| 应用 / 会话 | 运行中 pending、idle apply、flush 失败、session op 互斥、候选实例事件隔离与旧会话重开回归。 |
| GUI | custom 字段 / 校验、四家切换、档位、保存 / 待应用 / 测试 / 错误状态有现有 Vitest 测试。 |

从定向测试开始，再运行根 `typecheck`、`runtime:test`、`frontend:test`、`build`，以及 `cargo test --manifest-path src-tauri/Cargo.toml`。具体新增测试加入正式测试入口，不依赖 `.cache` 下临时审计才成立。环境阻断按实际结果记录；数字不得照抄历史。真实厂商 key 由用户提供时才测试，不读取或输出现有私密配置来猜连通性。

## 7. 不在本任务完成的验收

Windows 凭据管理器实机、至少一家真实厂商完整聊天 / 工具 / thinking 路径、安装包及干净机器运行统一在发布收口执行；开发中可留定向实测证据，但不强制每点跑全套。两类本地协议夹具通过不等于所有第三方 API 可用。

任务结束时写清：改动文件、自动门禁、未执行项、已知限制、对应 issue；不自动 commit / push，不开始 07a。后续功能另写短 plan 后执行。

## 8. 实现记录（2026-11-10）

**改动文件**

- 新增 `agent-runtime/src/custom-route.mjs`：路由声明校验、Pi provider / model 构造、能力过滤与 catalog 投影。
- `agent-runtime/src/settings-schema.mjs`：`provider` 接受 `custom`；新增 `custom_protocol` / `custom_model_name` / `custom_context_window` / `custom_max_output` / `custom_reasoning` / `custom_images` / `custom_tools`；`custom` 成为独立凭据槽位。
- `agent-runtime/src/config.mjs`：custom 字段参与同一套 env > settings > legacy > default 来源解析与 effective revision。
- `agent-runtime/src/provider-settings.mjs`：`selectConfiguredProvider` / `getProviderCatalog` 对 custom route 走同一解析路径。
- `agent-runtime/src/settings-service.mjs`：catalog 与 get / save 投影 `custom_route`（成功或具体失败码）。
- `src-tauri/src/credentials.rs`：凭据槽位增加 `custom`。
- `src/lib/settings.ts`、`src/SettingsPanel.tsx`：provider 下拉增加 Custom API；协议、model id、容量、能力控件；无 catalog 时不再强制选择 catalog 模型。
- `package.json`：`runtime:test` 纳入新测试文件。

**设计取舍**（plan 允许实现时一次定义的部分）

- 路由复用 `provider` / `model` / `api_url` 三个既有字段，只新增协议与声明字段；没有另造第二套设置形状。
- 未声明的能力一律不发：`custom_reasoning=false` 时 `reasoning: false`，Pi 不发送 reasoning 字段；`custom_images=false` 时 `input: ["text"]`；`custom_tools=false` 时在 adapter 层剥离工具定义。
- `custom_tools` 缺省为 `true`，因为产品是工具型文件 agent，缺省关闭会让首个任务失败；`custom_reasoning` / `custom_images` 缺省为 `false`。
- 任意 OpenAI 兼容端点采用保守 compat（无 `store`、无 `developer` 角色、`max_tokens`、无 strict schema），不开启任何厂商扩展。
- 容量由用户显式给出，`max_output` 不得超过 `context_window`，未知端点不假设无限窗口。
- 未修改 `vendor/pi`，通过 `@earendil-works/pi-ai/api/*.lazy` 子路径复用两组 vendored adapter。

**自动门禁**：`runtime:test` 525/525（新增 14 项，含 Chat Completions 与 Responses 两类本地 HTTP/SSE 真实 adapter、工具往返、取消语义、错误流、环境覆盖与凭据隔离）、`frontend:test` 66/66（新增 3 项）、`cargo test` 57/57、`typecheck`、`build` 通过。

**已知限制**

- 仅本地夹具与本地 HTTP 服务器证据；没有任何真实厂商端点被调用，B1–B9 / H1 / H5 仍未执行。
- Windows 凭据管理器实机未验证；Rust 测试只覆盖 `validate_provider` 白名单，实际读写仍是既有实现。
- 未提供鉴权头自定义（如某些网关的 `api-key` 头）；需要预置 Bearer 之外的方案时另立任务。
- 声明 `custom_reasoning=true` 时向端点发送 `reasoning_effort`，与既有四家一样，是否被真实端点接受未验证。
- 能力声明是配置约束，不是厂商质量保证；连接测试成功只证明一次探测。
