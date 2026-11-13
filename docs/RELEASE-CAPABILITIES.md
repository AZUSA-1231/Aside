# Release 能力对照与现状审计

更新：2026-11-09；原对照日期 2026-11-08。Aside 产品代码基线：`bf3f231`，讨论文档基线 `0e8b587`。本轮源码定向盘点未修改产品代码或重跑产品测试，不重新宣称厂商文档为最新。本文是功能事实与取舍依据，不是第二份执行总计划；首版合同见 [V1-SCOPE](./V1-SCOPE.md)，状态见 [RECOVERY-PLAN](./RECOVERY-PLAN.md)。

2026-11-09 用户认可：五里程碑推进，最小 M11 纳入首版并优先于完整配套能力验证；“可选”指用户可以关闭，不是可以不交付。Agent 创建不进首版；会话 / 运行 / 产物入口是基础功能，不冒充 memory。禁止后台采集个人信息与画像，详细机制逐任务先 plan。

## 1. 证据范围

- 已阅读当前 Aside 源码、Cycle 8 计划及问题记录。下文“已有”指产品路径已接通并有开发证据，**不表示统一实机验收通过**；仅 helper / 类型 / 注入测试具备的能力标为“底层有，产品未接通”。
- DeepSeek Harness 使用用户放入的本地快照：`vendor/deepseek-harness`，HEAD `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，提交日期 2026-11-04，包版本 `0.2.2-rc.1`。只读，未安装、运行或修改它，也没有把它加入本次提交。该路径自 2026-11-13 起写入 `.gitignore`，防止误提交。
- 2026-11-13：参考树当前不在本机，以上事实是当时某个快照的记录，尚未在现环境复核。R1-01 期间有若干设计因缺少该参考而自行判断，清单与复核顺序见 [RECOVERY-PLAN 暂停与恢复清单](./RECOVERY-PLAN.md#2026-11-13-暂停与恢复清单)。
- 该仓库 README / SAFETY 明确声明 developer preview、未安全审计；它是工程参考，不是“成熟产品全部功能都必须复制”的标准。下表的 DSH 能力有些是可选组合，不把存在 package 当成默认启用或稳定交付。
- 另查 Codex、Claude Code、OpenCode 官方文档，使用文末链接；只比较具体能力，不比较模型效果、价格、账户权益或宣称完全功能等价。
- 统一实机验收依用户最新决定默认延期；保留未执行状态。延期不等于通过，也不等于已经可以公开发布。

## 2. 先纠正几个分类

1. **Provider ≠ Agent ≠ Session。** 模型连接配置、工具 / 指令组合、一次对话是三种对象。首版单个默认 Agent 可成立，不必先做多 Agent 管理器。
2. **Ask User ≠ Approval。** 补充需求 / 做选择不能代替执行授权；有权限卡不代表有结构化提问。
3. **Compaction ≠ Memory。** 压缩管理本次模型上下文；工作索引帮助跨会话找回资料和产物；历史 JSONL 是记录，不自动等于这两种能力。
4. **Registry ≠ Marketplace。** 代码里的工具注册与本地 skill 导入不需要公开插件生态；第三方代码安装会扩大安全与分发责任。
5. **隐藏后继续当前任务 ≠ Background Tasks。** 前者已有；后者还包含独立任务身份、调度、恢复和资源管理，不因面板可隐藏就算完成。
6. **路径 / 审批策略 ≠ OS Sandbox。** Aside 内建工具受自身边界约束，不代表被用户启用的本地 MCP 子进程被操作系统隔离。

## 3. 第一版逐项清单

“补齐”的有限范围以 2026-11-09 的 V1-SCOPE 为准，逐功能先 plan 再执行。M01 的 R1-01 已完成开发并通过自动门禁，其余模块仍未实现；单模块完成不代表里程碑或发布完成。R1/R2/R3 在本文表示发布阶段，和历史恢复计划的 R1–R4 不是同一套编号。

| ID / 模块 | Aside 当前实际状态 | DSH 对照 | Release-1 的建议终点 | 明确不做 |
| --- | --- | --- | --- | --- |
| M01 Provider / Model | 四家 provider、catalog、Base URL、原生凭据、连接测试、thinking 和安全重建；另有 R1-01 已实现的单个 custom route：`provider: custom`，显式 Chat Completions / Responses、model id、Base URL、上下文 / 输出容量与 tools / reasoning / image 声明，凭据为独立原生槽位。测试与实际任务共用同一解析路径；本地两类协议夹具通过，真实厂商未测。 | `llm-pi-ai` + Models 设置支持 catalog 及手工 API 路由。 | 保留四家；custom route 已按显式协议、URL、model id、容量、能力约束实现，并有真实请求形状证据。不是只增加自由文本输入。 | 多账户 / 多 profile、登录订阅适配、所有网关兼容矩阵。 |
| M02 默认 Agent 设置（不含创建） | runtime 内部会创建默认 Agent；没有用户级 Agent 定义、instructions 或命名 Agent 管理。新建会话不等于创建 Agent。 | `agent-loop`、`agent-preset` 和 preset UI。 | 保留默认实例，模型 / 工具 / skill 由各模块配置；指令编辑仍是待确认建议，不列为已确认必补。 | 用户侧 Agent 创建、角色 / 模板管理、动态插件树、重写 agent loop。 |
| M03 Tools | 已有 registry、来源分类、参数校验、逐次权限和八项文件 / 文档工具；MCP 工具按任务注册。没有用户侧内建工具开关。 | `core/tools` 注册、策略与 executor 分离。 | 工具清单、来源 / 风险 / 可用性和启停入口；停用在执行器生效，不只是隐藏 UI。配置在下次任务生效。 | 用户上传任意 JS 工具、shell / 代码执行、任意“始终允许”。 |
| M04 Skills | 有发现 / frontmatter / 冲突诊断 / manifest / 激活；生产默认只连内建根。user/project resourcePolicy helper 存在，但未由设置接通；无安装 / 管理入口。 | `skill-filesystem` + `tool-skill` + skill UI。 | 接通用户本地 skill 目录；本地目录导入、查看来源、启停、刷新、加载错误。显式采用 / 自动激活沿用标准技能材料；不执行安装脚本。 | 在线 marketplace、git/npm 一键运行依赖、任意项目目录自动信任。 |
| M05 MCP | 已有 stdio 配置 CRUD、启用与信任分离、间接凭据、测试、工具发现 / 分类 / 审批。仅 stdio tools，不是所有 MCP 能力。 | `mcp-client` 支持 stdio / HTTP 及资源，默认无 server。 | 保持本地 stdio tools；把列出的配置完整性 / 同 id 编辑问题收口，显示实际连接 / 生效状态。测试连接不等于隔离运行。 | HTTP / OAuth、资源 / prompt 全集、自动安装 server、服务市场。 |
| M06 Settings | Cycle 8 已有 API、模型、thinking、目录、会话目录和 MCP 入口，统一读写 / revision / 来源 / 待应用。 | `settings`、credentials、多个 UI 设置分区。 | 所有 R1 的用户可调项进入同一入口；至少能找到路径、解释默认 / 覆盖 / 待应用和失败；不等于把所有内部参数做成 GUI。 | 任意框架配置编辑器、项目 / 全局多层合并、多份可写配置。 |
| M07 Session | 新建、列表、切换、改名、删除、重启恢复；P6 补写入 / 重建保护。恢复不带旧授权。 | agent-loop + session persistence / query / projections。 | 保持以上范围；与压缩 / 工具历史新增数据兼容。历史与产物分离，删除历史不删文件。 | fork / branch、搜索导出、跨引擎迁移、崩溃后自动重放副作用。 |
| M08 Tool Calling / 产物交付 | 有 start/update/result 协议与单个 `toolActivity`；documentWrite 卡和 revealFilePath 已接通。`isDurableMessage` 已保存 assistant 调用与 toolResult，`restoreAsideSession` 恢复完整 messages 供 agent，但 history 仅投影文本。缺产品关联 / 恢复展现，不能说工具结果未保存。 | `ui-tool` / `ui-trajectory` / durable session log。 | 04a 复用已存消息做最小有界关联 / 恢复投影，只补确实缺少的字段；06a 接真实产物与已有入口，04b 补完整时间线，不另造日志库。 | 全量载荷 dump、执行回放、复杂轨迹分析器、新造产物管理平台。 |
| M09 Ask User / Approval | Approval 已有 allow/deny、绑定 request/task/call、过期 / 取消；缺少独立的结构化 Ask User 产品通道。 | `user-questions` / `tool-ask-user` 与 `user-approval` 是不同模块。 | 简单阻塞式问题：文本或单选、回答 / 取消 / 会话生命周期；不自动代答、不视为授权。产品层有稳定交互请求，当前 Pi 只作适配。 | 定时回答、多问题工作流、子 agent 提问转发、静默权限提升。 |
| M10 Context Compaction | 产品未接通。已有工具结果 / 输出字节限制和会话持久化，不是上下文压缩；Pi 有相关存储类型也不等于 Aside 已支持。 | `token-meter` + `compaction-basic` + `/compact`。 | 请求压力估算、输出预留；保留近期消息和完整 tool-call/result 对；自动阈值 + 手动压缩；取消 / 失败保留原历史。原始记录不覆写，压缩点可重开。 | 多模型摘要调度、跨会话压缩、无限重试、“永不超窗”承诺。 |
| M11 最小项目记忆（可关闭） | 会话 JSONL 已有但不算 memory；自动项目索引与跨会话检索未实现，continuation 仍为会话内状态。来源 / 输出目录独立于会话库，后者受保护。 | DSH 的 memory 文档是默认关闭的第三方 MCP 示例，不是自带完整长期记忆产品。 | 里程碑 2 / 06b–06d：逻辑项目文件夹 + README + 会话 / 目录引用；开启时按需取相关历史并自动路由目录，必要歧义才询问，支持最小排除 / 纠错。 | 任务外后台采集、个人画像、全历史注入、复杂归并 / 拆分、向量库 / 独立分类 agent / 后台自整理；不放开私有会话根或恢复旧授权。 |
| M12 错误 / 日志 / Token | 已有错误脱敏、重试入口、取消、资源限额、session 警告。缺产品级本地诊断日志、每轮 usage / 上下文占用显示；Pi 消息带 usage 不等于 GUI 已统计。原生 runtime stderr 当前丢弃。 | `token-meter`、session stats / telemetry、retry policy。 | 有界本地脱敏日志与诊断导出；request/session/call 标识；每轮 / 会话 token，区分厂商报告和估算，缺失不填 0。用于压缩的压力估算不是计费统计；价格未知不编造费用。 | 云端遥测平台、计费对账、全量模型正文日志、无限自动重试。 |
| M13 Aside 核心交互 | 已有快捷键呼出 / 隐藏、全高侧栏、80/20 排列恢复、显式 capture、动态外部焦点、context 预览移除、来源 / 输出分离、文件 / PDF / DOCX 与产物定位；原生联合观察延期。 | DSH 的通用工作区 / 浏览器 / computer-use 不等于 Aside 的桌面捕获体验。 | 保持现有边界，必要错误反馈；不再设计窗口材质 / 分岛。焦点监听不等于持续采集；capture 不授予权限。 | Mac、常驻桌面部件、新窗口体系、后台主动 capture、第一方 Web search、任意 shell。 |
| M14 交付 / 安全基线 | 有 staging 脚本、打包契约和自动测试；未完成安装 / 干净环境 / 真实厂商联合验收。 | DSH SAFETY 自述预览与限制，不能用其功能数量替代安全证据。 | 有限文档、依赖 / 版本 / Node 资源可复现；功能开发结束后统一做实机与分发验收。发布前阻断缺陷为零。 | 每功能都重跑整套实机、自动更新 / 签名平台、OS sandbox 宣称。 |

### 当前源码的核对入口

| 事实 | Aside 证据 |
| --- | --- |
| 四家与 catalog 限制 | `agent-runtime/src/provider-settings.mjs`：providerFactories / selectConfiguredProvider；`settings-schema.mjs`：SETTINGS_FIELDS |
| 默认 Agent / 内建 skills 路径 | `agent-runtime/src/runtime.mjs`：loadRuntimeSkills / createConfiguredAgent；`skill-loader.mjs`：loadSkills 的 resourcePolicy |
| 工具 / 权限 / MCP | `agent-contracts.mjs`、`capability-policy.mjs`、`permission-broker.mjs`、`mcp-config.mjs` 的 MCP_TRANSPORTS；`src/McpSettingsCard.tsx` |
| 会话与压缩接入约束 | `session.mjs`：restoreAsideSession / createSessionPersistence 的前缀追加约束 / flushPersistence；`protocol.mjs` 的替换队列 |
| 工具 UI / usage 缺口 | `src/App.tsx`：单个 toolActivity、tool_call_started / tool_result、history_restored；`src/lib/contracts.ts`；`tool-events.mjs` |
| 原生诊断缺口 | `src-tauri/src/runtime.rs`：启动子进程时 `.stderr(Stdio::null())`；不是现有可交付的持久诊断日志 |

## 4. 既有六组 P2 的发布去向

编号和原严重度不变；2026-11-09 的有限范围已将 I035 / I038 / I039 纳入 R1-07a，但本轮未修复。仍须逐点 plan / 复现 / 回归。原问题保留在 [Cycle 8 ISSUES](./cycle-8/ISSUES.md)，release 归属索引在 [Release-1 ISSUES](./release-1/ISSUES.md)。

| 问题 | 本轮归属 | 原因 / 必须满足的边界 |
| --- | --- | --- |
| C8-I035 MCP 保存丢异常条目 | R1 收口 | 设置入口不能静默删掉不认识的用户配置。 |
| C8-I036 MCP 具体错误码丢失 | R2；R1 明示通用失败 | 已能报告失败；更精确分类不改变已有数据 / 权限。但不得显示假成功。 |
| C8-I037 删除失败后当前会话已变化 | R2；R1 接受有界限制 | 原历史仍在并可找回，切换事件已可见；R1 不承诺删除事务回滚，失败必须显示。 |
| C8-I038 跨会话残留旧产物 | R1 收口 | 会话 / 文件对象不能错配；这是现有承诺正确性，不是视觉扩展。 |
| C8-I039 MCP 同 id 覆盖 / 改 id 克隆 | R1 收口 | 编辑必须可预测，不能保留未意识到的启用 / 信任配置。 |
| C8-I040 慢 MCP 测试预算不一致 | R2；R1 接受明确超时 | 连接测试超时不是进程已残留；不承诺慢 server 的完整支持。若后续证实泄漏或错误显示成功则重新升级。 |

## 5. Release-2 / Release-3：候选，不是全部必做

| 阶段 | 能力组 | 当前状态 / 进入条件 |
| --- | --- | --- |
| R2 成熟产品 | 本地 Plugin Registry、agent 模板 / 命名配置、配置导入导出、session search/export/fork | Aside 无产品闭环；R1 完成后按真实使用需求选择，不先搭“万物插件”架构。 |
| R2 成熟产品 | 在线 skill 目录、远程 MCP / OAuth | 无；先定义来源验证、安装 / 更新 / 删除、凭据与信任模型。Skill Marketplace 是生态项，不是 M04 本地导入的同义词。 |
| R2 成熟产品 | Subagent、后台队列、定时任务、执行恢复 / 回放 | 无产品闭环；面板隐藏后当前任务继续不算已具备这些系统。先有持久任务身份、取消、配额和恢复语义。 |
| R1 最小闭环 / 后续扩展 | 自动项目归属 + 项目内历史检索（M11）进 R1；复杂归并 / 拆分、自整理另议 | 2026-11-09 已认可五里程碑方向；不再列 M11 发布阶段待定。基础记录、memory MCP 接通均不能冒充已完成项目上下文体验。 |
| R2 条件项 | OS Sandbox | 若引入 shell、可执行第三方插件或承诺隔离外部 MCP，必须先重新评估；现阶段保留路径 / 审批，不宣称 OS 隔离。 |
| R2 独立 feature | 外部 Codex / Claude Code 薄接入、Mac | 仍无排期，不是达到 R2 的必选条件。 |
| R3 平台候选 | Plugin / Agent Marketplace、多 Agent 协作、Workflow Builder、多工作区、多用户 / RBAC、第三方 SDK、远程 Runtime、多端同步 | 均无 Aside 产品承诺 / 完整交付；即便 Pi / DSH 有底层材料，也不据此算 Aside 已实现。逐项需要独立产品需求和验证，不作为必然路线图。 |

## 6. 参考来源与可借鉴范围

本地 DSH 路径以 `vendor/deepseek-harness/` 为根：

- `README.md`、`SAFETY.md`、`docs/architecture.md`：预览状态、全插件设计和自有 loop。**它复用 pi-ai 模型适配，不等于复用 Pi agent-core runtime**。
- `packages/llm/llm-pi-ai/README.md`、`src/adapter.ts`（PiAiAdapter / streamSimple）、`docs/user/guide/providers.md`：第三方 API 的协议、路由、模型元数据和凭据拆分。借鉴这个 seam，不迁移 Cordis / 全插件架构。
- `packages/core/tools/README.md`、`packages/preset/agent-preset/README.md`、`packages/skill/skill-filesystem/README.md`：声明与启用分开、能力组合、本地 skill 发现。
- `packages/interaction/tool-ask-user/README.md`、`packages/interaction/user-approval/README.md`：问题与执行授权分离。
- `packages/llm/token-meter/README.md`、`packages/compaction/compaction-basic/README.md` 及 `src/types.ts`：压力测量与统计区分、压缩阈值 / 输出预留 / 失败边界。不能直接照搬其默认 token 预算。
- `docs/user/guide/mcp-memory.md`：memory 服务是默认关闭的互操作示例，安装 / 数据库 / embedding 由第三方负责。

外部官方资料（2026-11-08 实际查阅；文档后续可能变动）：

| 来源 | 本次只用于确认 |
| --- | --- |
| [Codex CLI features](https://developers.openai.com/codex/cli/features/) | 模型选择 / reasoning、恢复、审批、工具和命令等属于用户可观察能力；不能只实现内部方法。 |
| [Codex Skills](https://developers.openai.com/codex/skills/) | skill 是指令与资源的可复用材料，不等同任意代码插件。 |
| [Codex MCP](https://developers.openai.com/codex/mcp/) | MCP 的配置、传输和认证是不同范围，不把 stdio tools 宣称为全 MCP。 |
| [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) | context / compact 等长会话管理入口。 |
| [Claude Code memory](https://code.claude.com/docs/en/memory) | 指令文件、记忆和上下文管理需要区分；不据此要求 Aside 实现个人画像。 |
| [OpenCode agents](https://opencode.ai/docs/agents/)、[skills](https://opencode.ai/docs/skills/) | agent 配置 / 工具权限 / 本地 skill 是可独立划界的对象。 |
| [OpenCode compaction](https://opencode.ai/docs/compaction/) | 明确的压缩机制与状态，而非仅输出截断。 |

产品优先级、首版阈值和延期选择是本项目的建议判断，不是上述产品替我们决定的行业强制标准。
