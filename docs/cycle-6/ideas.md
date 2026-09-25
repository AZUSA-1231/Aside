# Cycle 6 — 方向讨论简记（ideas）

状态：非正式备忘，用于梳理方向。尚未做实施计划。
日期：2026-09-09

本文件只记录讨论中形成的判断与待定问题，不替代后续的 PRD / PLAN。

> 2026-09-10：本简记已由正式的 [PRD](./PRD.md)、[执行计划](./PLAN.md)
> 与 [`plans/P*.md`](./plans/) 承接。若表述冲突，以正式文档为准。

## 1. 现状定位（从讨论中确认的事实）

- 运行链路：模型 API（pi-ai）→ Pi Agent 内核（vendor 的 aside.ts 切片）→ 我们的编排层（runtime.mjs 包一层 Pi 的 hooks）→ 我们的产品层（workspace / 权限 / 工具 / 技能 / 协议）→ Rust 子进程桥（NDJSON）→ React。
- 与 Pi 的解耦点：全链只有 `@earendil-works/pi-agent-core/aside` 这一个接触面。vendor 是刻意裁剪的小切片（~1900 行），升级成本被限制在"重裁剪 + 跑 80 个测试"。
- 需要跟进 Pi 的只有：内核/ai 版本更新时的切片再裁剪、hook 签名变更。产品层（~6000 行）和原生层（~5700 行）完全自维护。

## 2. 核心结论：Agent 内核策略

- **不换内核、不 fork 大项目（如 opencode）后冻结。** 大项目冻结的维护负担（provider API 变更、CVE、边界 case 修复）远大于当前 vendor 小切片。要复用成熟能力，正确姿势是"依赖上游 + 薄适配器"，只在产品身份要求处自己写。
- **opencode 这类 coding agent 与 Aside 产品身份冲突**（任意 shell、仓库信任、cwd 工作区都不是 Aside 的默认）。可作为"参考设计"（工具边界 case、权限规则思路），不作为 fork 目标。
- 结论：保住当前 Pi 小内核 + 产品层不动。

## 3. 关键区分：被动观察 vs 主动操作

这是讨论中最重要的模型：

| 平面 | 性质 | 实现方式 |
| --- | --- | --- |
| **观察平面**（宿主捕获上下文） | 被动、用户触发、隐私关键 | 保持 native（UIA + 路径描述符），**不走 MCP**。Cycle 4 硬编码策略是对的 |
| **操作平面**（agent 暴露的接口） | 主动、模型驱动 | 工具表面（含 MCP）。社区能力可接入 |

"决定如何思考"不是接口——思考留在模型里；要暴露的是"它能做什么"（工具表面）。

## 4. 能力接入决策规则

| 能力 | 集成方式 |
| --- | --- |
| 磁盘文件格式解析/生成（docx / xlsx / pdf） | **进程内适配器**（进 `createDocumentAdapterRegistry`），直接用库；可借鉴高质量 MCP 源码的领域逻辑 |
| 服务/应用集成（日历、Drive、Outlook、浏览器动作、VSCode…） | **MCP 桥接**（`createMcpTools()`，一次性稳定层） |
| 当前应用 UI 自动化（驱动 Word 界面等） | 暂不碰（产品身份冲突 + 无社区复用） |

### 4.1 文件层：库直接用，不借 MCP 外壳

- 从 MCP 源码值得借鉴的：**选型决策（用哪个库）、工具参数面设计、领域表示逻辑**（如何把 docx 结构化串给 LLM、编辑 diff、分块）。
- 不值得抄的：**传输/协议/注册胶水、它自带的权限逻辑、它对"工作区"的理解**。
- 理由：MCP 子进程会让 workspace 边界检查、有界限额、确定性测试全部失效；进程内适配器保持这些特性，且天然受权限代理保护。
- 落点：`createDocumentAdapterRegistry` 接缝已存在，加 adapter 即可；同时从 `unsupportedExtensions` 黑名单放行对应后缀。

### 4.2 MCP 桥接层（一次性工作）

- `createMcpTools()`：MCP tools 列表 → Aside registry（effect/scope 声明）。
- file-scoped 工具过 workspace 边界检查；write/external 走权限代理（逐次授权、预览、过期、重校验、结果有界化脱敏）。
- 真正的工作量不在"接进来"，而在**给外部工具套上 Aside 的安全语义**——社区 server 对 workspace 边界和逐次授权一无所知。

## 5. 格式上限（诚实声明）

- docx / xlsx：编辑 = 解析 → 模型改结构化表示 → 重新生成（zip+XML 本质，社区所有方案都如此）。可落在 PRD 已有的 "transform → bounded report/transformed output" 语义上。
- **PDF：只做读**（text + 结构化抽取）。PDF 就地编辑在整个生态中基本不存在，任何 server 也只是重建/覆盖。不对用户承诺 PDF 编辑。

## 6. 下一步候选（待定的实施清单，非计划）

1. **Workspace 自动填充**——闭环主线。宿主捕获路径描述符自动喂给 `runtime_set_workspace`，替代当前手输路径输入框，实现"在文件上呼出 → 自动进入该文件 workspace → 读/改它"。
2. **`createMcpTools()` 桥接层**——解锁"加点 mcp 就行"。
3. **docx / xlsx / pdf 读取适配器**（native，进文档 adapter 接缝）。
4. 选 1–2 个信得过的服务类 MCP server 接入桥接层，调对写入/外部语义。

## 7. 待思考问题

- 二进制格式的**写入**是否纳入 cycle 6 范围（先读后写？还是读+transform 生成新文件？）。
- 服务类 MCP 优先接哪几个（日历 / 文档协作 / 编辑器…），各自权限语义怎么声明。
- 借鉴 MCP/开源代码时的**许可证**核对（SheetJS 等有 license 变动的库要单独查）。
- 文档 adapter 是否需要统一"分块/长度策略"，避免每个 adapter 各写一套。
