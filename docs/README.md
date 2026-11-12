# 文档导航：当前工作、长期方向与历史留痕

更新日期：2026-11-10。本文是阅读导航，不维护容易过时的文件总数，不新增平行执行计划。当前主线是 Release-1 五里程碑推进，最小项目记忆已纳入首版；统一实机仍默认延期。

**R1–R4 当前有界开发与自动证据已完成。有限清单 RT-01–11 和候选功能处置见总计划第 7 节；R4 补齐 MCP 分类双绑定与失效提示。394 项 runtime、24 项前端及构建通过；完整原生 / 人工与产品级 runtime 验收尚未成立，G01 同步解析限制保留。**

既有收束快照为 `ea4db29`；[Cycle 8](./cycle-8/README.md) P0–P5 已提交，P6 严重缺陷修复为 `bf3f231`。R1-07a 实现后的当前门禁为 runtime 529/529、前端 70/70、Rust 57/57、类型 / 构建通过；07a 改动尚未提交。讨论文档已提交为 `0e8b587`；本轮将已认可的范围与验收对齐，只写首个功能 plan，不把规划算成实现完成。

## 1. 现在先看哪几份

| 文档 | 它负责什么 | 当前角色 |
| --- | --- | --- |
| [RECOVERY-PLAN.md](./RECOVERY-PLAN.md) | 当前里程碑 / WIP 与历史 FE／A／INT／RT 完成条件和证据。 | 唯一执行状态入口；先看 2026-11-09 当前表，不按历史恢复顺序开工。 |
| [cycle-8/README.md](./cycle-8/README.md) | 基础设置 / 会话 / MCP 的现状对照、六份功能 plan、issues 与验收目标。 | P0–P5 全部完成开发验证。 |
| [design/SUMMONED-SIDEBAR.md](./design/SUMMONED-SIDEBAR.md) | 快捷键采集→自动分屏→收起恢复；全高侧栏与连续底板、白色组件。 | 当前规范；R1 已开发实现，原生观察仍待补。 |
| [FRONTEND-REVIEW.md](./FRONTEND-REVIEW.md) | 当前技术栈、材质沿革、接口投影与开发检查、限制。 | 当前实现说明；区分 R1 浏览器证据与 R3 动态焦点开发回归，均不代表原生桌面验收。 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Rust／React／runtime 职责、状态与 IPC、上下文和权限边界。 | 仍使用的工程约束；其中当前源码描述与待恢复行为已分开标注。 |
| [PRODUCT-DIRECTION.md](./PRODUCT-DIRECTION.md) | Context、文件、memory、ambient、可替换 agent 与薄接入思路。 | 长期方向与讨论记录，不是当前全部获准开发的功能清单。 |
| [V1-SCOPE.md](./V1-SCOPE.md) | 首版有限承诺、五里程碑停止线与任务依赖。 | 已认可方向的范围合同；详细实现仍逐功能先 plan。 |
| [RELEASE-CAPABILITIES.md](./RELEASE-CAPABILITIES.md) | Aside / 本地 DSH / 官方产品文档的能力事实、模块现状、R1 增量与 R2/R3 候选、既有 P2 去向建议。 | 研究与决策依据，不是另一份执行排期。 |
| [V1-ACCEPTANCE.md](./V1-ACCEPTANCE.md) | 分层证明与集中实机步骤；F9 基础交付、F15–F24 最小项目记忆。 | 全部实机未执行；历史 F 项不作为现行门槛。 |
| [release-1/ISSUES.md](./release-1/ISSUES.md) | 本轮缺陷、继承 C8 去向和待定设计关口。 | 不重复旧 issue，不把待验证风险伪装成已复现缺陷。 |
| [R1-01 plan](./release-1/plans/R1-01-model-route.md) | 第一个功能的契约、实施边界、失败语义、自动门禁与实现记录。 | 已提交（`1b59071`）；真实厂商 / 实机未执行。 |
| [R1-07a plan](./release-1/plans/R1-07a-inherited-defects.md) | C8-I035 / I038 / I039 三项继承缺陷的复现、修复语义、门禁与实现记录。 | 开发完成、未提交；H6 / H7 实机未执行。 |
| [PROJECT-BASELINE.md](./PROJECT-BASELINE.md) | 2026-09 的项目状态、旧文档关系与范围决定。 | 历史基线，帮助追溯；不再负责当前排期。 |
| [design/README.md](./design/README.md) | 区分当前侧栏规范与旧 mockup。 | 设计目录导航。 |

当前阅读顺序：**总计划当前 WIP → 首版范围 / 验收 → 当前功能 plan**。需要核对现状再看能力对照；窗口问题看当前侧栏规范 / 实现复查，旧缺陷回原 issue 与证据。

换机接续可补读 [项目记忆讨论](./PRODUCT-DIRECTION.md#2026-11-08-补充归纳文件夹与项目记忆)，理解轻量方案由来。2026-11-09 最小版本已纳入 R1；讨论中的复杂扩展和未定技术选项不因此全部变成首版任务。

## 2. 现在、短期、后续分别做什么

以下表示先后关系，不承诺日期；具体状态只在 [RECOVERY-PLAN.md](./RECOVERY-PLAN.md) 维护。

| 阶段 | 工作 | 准备程度 |
| --- | --- | --- |
| 已执行：R1 | 自动采集 / 分屏 / 恢复；连续 Acrylic 底板、白色组件与既有接口投影。 | 开发实现与自动化检查完成；原生桌面观察和完整人工验收保留未执行。 |
| 已执行：R2 | A01–A12 自动化复核，修正不完整的续读、截断和搜索游标；重验 G01。 | [逐项证据](./cycle-6/R2-RECHECK.md) 与 [机器汇总](./cycle-6/R2-EVIDENCE.json)；379 项 runtime 通过，不能替代人工验收。 |
| 已执行：R3 | 动态焦点 Capture、现有 capture→文件 workspace→工具→权限→结果的集成核对。 | [集成记录](./cycle-6/R3-INTEGRATION.md) 和 [Windows 合成测量](./cycle-6/R3-BENCHMARK.json)；388 项 runtime、45 项 Rust、23 项前端与构建通过，真实桌面待复测。 |
| 已执行：R4 | 定义 RT-01–11，补齐 POLICY-01，明确 LIMIT-01 与设置 / 会话 / skill 等候选功能处置。 | [开发证据](./cycle-6/R4-RUNTIME.md)；394 项 runtime、24 项前端和构建通过。有限开发清单完成，产品级验收未成立。 |
| 已执行：Cycle 8 开发 | 设置、默认目录、会话、思考强度与 stdio MCP GUI，另含 P6 可靠性修复。 | P0–P6 开发与自动回归已有证据；P6 已提交，六组 P2 仍未修复，统一实机未执行。 |
| 当前：里程碑 1 进行中 | R1-01 已提交；R1-07a 开发完成；04a / 06a 未开始。 | 具体 WIP 只看总计划当前表。 |

历史恢复 R1–R4 与 Cycle 8 的已授权开发已收口；本次不用 Cycle 9，按里程碑 / 功能任务推进，逐点 plan / 执行 / 记 issue。外部 agent、Mac 与窗口渲染研究不回流。实机默认延期到统一收口，不重复阻塞逐功能开发；公开发布前仍须具备实机与分发证据。

## 3. 长期方向、条件延期与无限期延期

| 类别 | 内容 | 去哪里看 |
| --- | --- | --- |
| 长期产品方向 | 更深入的 context capture、持续感知、本地资料组织、memory、自整理、低配置负担。 | [PRODUCT-DIRECTION.md](./PRODUCT-DIRECTION.md)；既有 capture／文件能力的缺陷不因此归入长期。 |
| 有前置条件的后续 feature | Codex／Claude Code 接入、薄适配、skill／文件交接；至少等待当前 runtime 功能齐备后再单独立项。 | 同上，以及总计划 F1。尚未选定或实施接入方案。 |
| 未来平台方向 | Mac 及其原生材质／宿主支持。 | 同上及当前侧栏规范的平台边界；没有移植排期。 |
| 无限期延期，保留未执行状态 | 全套 Cycle 5/6 Windows／provider／真实文档人工验收、新 UI 完整人工验收、安装包、干净环境安装与发布。 | [MANUAL-ACCEPTANCE.md](./cycle-6/MANUAL-ACCEPTANCE.md)、[PACKAGING-CONTRACT.md](./cycle-6/PACKAGING-CONTRACT.md) 和总计划的 EVID／RELEASE 项。不是废除，也不是当前必须先完成的步骤。 |

开发期间的定向测试、类型检查和构建继续执行；它们不能替代延期的人工验收，也不能据此宣称发布或整轮验收完成。

## 4. 每个目录里是什么

| 位置 | 内容与用途 | 现在如何使用 |
| --- | --- | --- |
| `/docs` 根目录，8 份 Markdown | 本导航、总计划、v1 范围与验收、长期方向、架构、实现复查和历史基线。 | 按第 1 节区分职责，不把六份都当作执行计划。 |
| [design/](./design/)，3 个文件 | 当前 `SUMMONED-SIDEBAR.md`、设计导航和旧 `mockup.html`。 | 当前要求与历史原型同目录，按导航明确区分。 |
| [cycle-1-MVP/](./cycle-1-MVP/)，8 份 Markdown | 初版悬浮助手、Pin／workspace、对话；`PRD`、`PLANS`、子计划与 `VERIFICATION`。 | 历史实现与“accepted with limitations”证据；不是新的待办。分屏恢复可追溯相关旧实现与要求。 |
| [cycle-2/](./cycle-2/)，7 份 Markdown | 侧栏、原生几何与快捷键；需求、计划、子计划、验证。 | 历史实现。Windows 人工证据曾向后结转，不等于当前已经补齐。 |
| [cycle-3-pi-implementation/](./cycle-3-pi-implementation/)，7 份 Markdown | Pi 内核、上下文模型、会话与 runtime 协议；含 `ISSUES`。 | 当前 runtime 的来源。阶段已实现，未另留 closeout；旧 `active` 指当时的日志阶段。 |
| [cycle-4-contextual-sidecar/](./cycle-4-contextual-sidecar/)，41 个文件 | 宿主 context capture、UIA／路径策略；15 份 Markdown 与 26 份研究样本、截图、原始输出。 | 保留能力与研究来源。CDP 等“研究完成”不等于已接入生产，也不自动变成下一步任务。 |
| [cycle-5-agent-capability/](./cycle-5-agent-capability/)，10 份 Markdown | 任务／workspace、工具、权限写入、skills、会话与 IPC；需求、计划、issue。 | 已实现能力的历史要求与问题来源；人工证据结转未关闭。 |
| [cycle-6/](./cycle-6/)，24 个文件 | 文件／PDF／Word／MCP／策略能力；20 份 Markdown 加审计数据、R2/R3/R4 证据与复现脚本。 | **混合目录：旧研发计划是历史，审计／issue／验收状态仍需追踪。** 不能整体废弃。 |
| [cycle-7/](./cycle-7/)，7 份 Markdown | 上一轮 UI 提案、旧开发／遗留拆分、执行记录、两版材质记录及导航。 | 旧路线与证据来源；不再直接按旧计划开任务，详见该目录导航。 |
| [cycle-8/](./cycle-8/)，含 P0–P6 | 周期定义、功能与修复 plan、开发 issues。 | 开发与独立验收修复证据已记录；不能当成统一实机已通过。 |

## 5. 已废止或被取代、但保留留痕的内容

| 文档／路线 | 处置 | 为什么保留 |
| --- | --- | --- |
| [cycle-7/UI-PROPOSAL.md](./cycle-7/UI-PROPOSAL.md) 的 Collapsed／Preview／Engaged／Pinned 四态、常驻胶囊与悬停展开 | 退出本轮主线。 | 追溯旧要求、取舍和范围决定，不要求把未完成效果补完。 |
| [design/mockup.html](./design/mockup.html) 与 WinIsland 旧合并方向 | 被当前侧栏规范取代。 | 保留视觉来源；不能继续按旧原型的多档半透明材质或胶囊形态实施。 |
| [cycle-7/PLATE-V2-STYLE.md](./cycle-7/PLATE-V2-STYLE.md) 的透明分岛 | 路线已废止，当前代码已在 R1 替换。 | 保留旧边缘问题与参数来源；不能继续作为当前视觉规范。 |
| [cycle-7/ACRYLIC-V1-STYLE.md](./cycle-7/ACRYLIC-V1-STYLE.md) 的整版 UI | 存档对照，不整体回退。 | 原生 Acrylic 方向可复用；旧胶囊、交互和整版布局不随之恢复。 |
| [cycle-7/PLAN.md](./cycle-7/PLAN.md)、[LEGACY.md](./cycle-7/LEGACY.md)、[EXECUTION.md](./cycle-7/EXECUTION.md) 的旧排期 | 被当前总计划取代。 | 保留新开发／遗留拆分及证据沿革；其中未解决的缺陷按总计划继续追踪。 |
| [cycle-6/plans/P5-web-search.md](./cycle-6/plans/P5-web-search.md) 的第一方 Web Search | **明确撤销，不实施，不自动转交其他计划。** | 留存 C6-I026 的能力取舍及未来搜索能力应遵守的边界，不是欠下的功能。 |
| [cycle-6/ideas.md](./cycle-6/ideas.md) 和早期周期计划的排期 | 当时的讨论／执行记录。 | 后续正式决定已承接；未明确保留的 wishlist 不自动进入当前清单。 |

**全高侧栏、快捷键自动分屏和原窗口恢复没有被废除。** 上一轮删除实现是误删，必须按 FE-07 恢复。早期 Cycle 1–6 中仍采用的 capture、权限、文件与 runtime 约束也没有因计划归档而失效。

## 6. 哪些是证据，不能当成新计划

| 文件 | 负责的事实 |
| --- | --- |
| [cycle-6/ISSUES.md](./cycle-6/ISSUES.md) 的 C6-I035／I036 | A01–A12、取消／响应性、修复与独立复核状态的源记录。 |
| [AUDIT-REPORT.md](./cycle-6/AUDIT-REPORT.md)、[AUDIT-EVIDENCE.json](./cycle-6/AUDIT-EVIDENCE.json)、[AUDIT-REPRO.mjs](./cycle-6/AUDIT-REPRO.mjs) | 当次审计的发现、捕获结果与复现方式；不等于当前版本已经复现或通过。 |
| [R2-RECHECK.md](./cycle-6/R2-RECHECK.md)、[R2-EVIDENCE.json](./cycle-6/R2-EVIDENCE.json)、[R3-INTEGRATION.md](./cycle-6/R3-INTEGRATION.md)、[R3-BENCHMARK.json](./cycle-6/R3-BENCHMARK.json) | 分别记录对应工作区的复核、集成与测量；R2 的源码摘要保持历史值，R3 改动后不能再当成当前源码摘要。 |
| [R4-RUNTIME.md](./cycle-6/R4-RUNTIME.md) | 有限清单的开发证据、MCP 分类修正、失败与源码摘要；R2/R3 历史结果不回写成 R4。 |
| [AUDIT-BRIEF.md](./cycle-6/AUDIT-BRIEF.md) | 原审计任务说明，只有开展对应审计时才使用；不是项目阅读总入口。 |
| [ACCEPTANCE-MATRIX.md](./cycle-6/ACCEPTANCE-MATRIX.md) 与 [MANUAL-ACCEPTANCE.md](./cycle-6/MANUAL-ACCEPTANCE.md) | 保留标准、证据归属和人工空白；不能因为排期变化而删除未完成项或写成已通过。 |
| `cycle-4-contextual-sidecar/research/samples/`、`research/real-test/` | UIA 树、采集元数据、探测输出和截图。属于研究证据，不是另一套待实施需求。 |
| 各周期 `VERIFICATION.md`、`ISSUES.md` 及子计划的检查记录 | 对相应时期和 revision 的事实；旧测试数、旧截图不证明当前代码或新设计正确。 |

## 7. 后续维护规则

- 当前任务与状态写入 `RECOVERY-PLAN.md`，当前侧栏决定写入 `design/SUMMONED-SIDEBAR.md`，实现映射与开发结果写入 `FRONTEND-REVIEW.md`；不另起一套平行总计划。
- 长期讨论进入 `PRODUCT-DIRECTION.md`；只有明确纳入当前范围后才转成总计划中的任务。
- 旧 `PRD`／`PLAN`／`ISSUES` 里的 `active`、`open`、`current` 先按其所属时期理解；具体保留缺陷以最新处置和原证据记录共同判断。
- 新决定取代旧方案时更新导航和处置说明，保留原问题编号、证据、失败与历史验收空白。本轮只整理入口和说明，没有移动目录或删除历史文件。
