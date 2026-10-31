# Cycle 6 独立审查报告

**2026-10-31 follow-up:** [R2 automated recheck](./R2-RECHECK.md) and [current evidence](./R2-EVIDENCE.json) record A01-A12 checks and the additional A07/A08/A10 fixes. Historical counts and findings below retain their dated scope. Manual acceptance and release remain deferred; no criterion is closed solely by this follow-up.

审查日期：2026-09-19。代码基线：`e5e8a09eda581c4d202e843b9ca890c761890c81`。
问题主记录：[C6-I035](./ISSUES.md#c6-i035---passing-gates-do-not-establish-cycle-acceptance)。
复现入口：[AUDIT-REPRO.mjs](./AUDIT-REPRO.mjs)；当次输出：[AUDIT-EVIDENCE.json](./AUDIT-EVIDENCE.json)。

## 1. 结论与审查边界

**不建议签署 Cycle 6 验收完成。** 功能实现阶段已经交付了大量工作，主要架构方向和多数范围收束有合理依据；但当前代码存在 6 项 P1、6 项 P2 问题，保留范围内的功能和可靠性承诺尚未成立。此外，解析响应性、Windows 手工验收和文档状态仍有独立缺口。

这里的 P1 表示应优先修复、阻塞本轮验收的严重功能/数据完整性问题；P2 表示同样需要处置的正常优先级缺陷，并不自动允许带入下轮。没有把撤销的 Web Search、尚未交付的安装包或设置界面算作当前实现缺陷。

审查覆盖 PRD、PLAN、ISSUES、验收矩阵、手工验收清单、P0–P7 相关设计与证据、Cycle 5 遗留验收、架构原则，以及 workspace/document/MCP/policy/runtime/UI/provider 序列化的实现衔接。复核了从 `5e25fee` 到当前 HEAD 的变更：59 个文件、16,105 行增加、399 行删除。这说明范围增长，但不是质量评分。

文档在 gitignore 中，不能用 Git 重建其全部修改历史。本次能够确认当前决策记录、引用和代码是否一致；不能独立证明每一次范围修改的具体提出者、批准者和先后时间。测试通过也不等于未经执行的手工步骤完成。

## 2. 代码发现

以下代码行号均对应审查基线。每个发现的修复验收要求都是后续工作，本次未修改生产代码。

### A01 · P1 · PDF 页码可以让 runtime 主线程永久循环

- 位置：`agent-runtime/src/pdf-adapter.mjs:72`、`:88`。
- 触发：`parsePageRange('9007199254740992')`。输入符合字符串页码语法，范围长度也只有 1，但超过安全整数边界，`page += 1` 无法推进。
- 证据：独立子进程执行该函数，2 秒后由外部 watchdog 杀死，得到 `ETIMEDOUT`。不是复杂 PDF 或大文件才会触发的问题。
- 影响：事件循环被阻塞，同线程 timeout/AbortSignal 无法救场；违反 C6-05/C6-19 的可取消、有界承诺。
- 修复验收：迭代前验证 finite/safe integer 和允许范围；覆盖安全整数边界、溢出及合法页码。独立进程或 Worker 验证极端输入不能卡住主运行时。

### A02 · P1 · Word 的“只创建新文件”仍能覆盖并发出现的文件

- 位置：`agent-runtime/src/workspace.mjs:819`；`agent-runtime/src/docx-tools.mjs:405`。
- 触发：目标不存在，通过 `beforeRename` 检查后，另一个写入者在实际 rename 前创建同名文件。
- 证据：通过现有 filesystem seam 精确注入该时序，随后调用真实 Windows 文件系统 rename；`CONCURRENT_OUTPUT` 被 `ASIDE_OUTPUT` 替换。
- 影响：丢失用户/其他进程的文件，直接违反 C6-I009 和 C6-24。现有“等待批准期间出现目标”的测试没有覆盖最终检查到提交之间的窗口。
- 修复验收：新文件提交必须采用具有“不替换已有目标”语义的原语；不能靠增加一次 existence 检查消除竞态。保留普通文本替换的独立语义，测试最终提交竞争、失败清理及原文件字节不变。

### A03 · P1 · Word 表格读出后在工具边界被全部丢弃

- 位置：`agent-runtime/src/docx-adapter.mjs:146`；`agent-runtime/src/workspace-tools.mjs:792`。
- 原因：适配器输出 `table.rows`；公共渲染器只处理 `page_break` 或 `block.text`，不序列化表格。
- 证据：真实生成的仅含表格 DOCX，经 `workspace.read` 返回 `succeeded`、`truncated: false`，表格标记 `AUDIT_CELL_8731` 在整个工具结果中消失。
- 影响：模型无法阅读普通 Word 表格，且不知道遗漏；违反 C6-20。适配器层检查 rows 的测试不能证明模型收到 rows。
- 修复验收：在 provider 可见内容中保留所有支持的 block 类型、顺序和必要定位。用表格、列表、段落混合文件走完整工具路径，断言每个标记实际抵达模型输入。

### A04 · P1 · MCP 成功结果的正文不会进入模型请求

- 位置：`agent-runtime/src/mcp-adapter.mjs:239`；`agent-runtime/src/capability-result.mjs:141`。
- 原因：MCP 的 text/structured/links 只放进 `details`，`content` 只有“server completed tool”。Pi 的 OpenAI 序列化读取 `content`：`vendor/pi/packages/ai/src/api/openai-completions.ts:1376`、`openai-responses-shared.ts:298`。
- 证据：faux transport 返回 `AUDIT_RESULT_4291`，工具 details 有该标记，content 没有。结合 provider 转换代码，能够确认这条路径不传送结果正文；本次没有调用真实网络 provider。
- 影响：MCP 调用显示成功，但模型无法利用查询结果继续任务，C6-36 的“归一化结果”没有形成可用的模型契约。
- 修复验收：将有界、已净化的业务结果放入 provider 可见 content；保留独立 UI 元数据。对 text、structured-only、links、错误结果和截断结果验证最终 provider payload，不能只验证内部 Context/details。

### A05 · P1 · 单个 MCP 工具定义可以破坏整个任务的注册表

- 位置：`agent-runtime/src/mcp-adapter.mjs:278`；`agent-runtime/src/runtime.mjs:1031`。
- 原因：逐项 MCP 接收并不等于最终 Aside descriptor 合法；缺少重复名过滤，描述截断上限也与 registry 的 800-byte 上限不一致。
- 证据：一个 server 返回两个同名工具，适配得到 2 个工具且无 diagnostic，聚合 registry 抛重复注册错误。1000 字符描述同样通过适配，聚合时报 `tool.description must be at most 800 bytes`。
- 影响：发生在 `agent.prompt` 前，连无关 built-in 工具任务也无法启动，直接违反 C6-32/C6-39 的故障隔离。
- 修复验收：逐候选验证最终 descriptor，处理最终命名碰撞并给出局部 diagnostic。对坏工具、好工具和 built-ins 混合的完整 runtime 证明坏工具不影响其他能力。

### A06 · P1 · MCP discovery 期间 Stop 后仍然向 provider 提交 prompt

- 位置：`agent-runtime/src/runtime.mjs:624`、`:1031`、`:1041`、`:1104`。
- 原因：准备阶段的异步 discovery 不共享可取消生命周期；`cancel()` 在 Agent 尚未启动时 abort，discovery 返回后没有再次检查取消状态就调用 `agent.prompt()`。
- 证据：延迟 MCP toolFactory，在等待中 cancel，再放行 factory。faux provider 仍收到 1 次调用，最终事件却是 `cancelled`。
- 影响：用户已经 Stop，任务仍提交内容并可能产生费用；终态数量正确不能证明取消生效。违反 C6-05，也影响 C6-37/C6-44。
- 修复验收：run 级 AbortController 覆盖 workspace/setup/discovery/provider，异步边界后检查取消；测试 Stop 后 provider 调用数为 0、后续 MCP/write 不启动、仅一个终态。

### A07 · P2 · 结构化文档续读会跳过内容或无法推进

- 位置：`agent-runtime/src/workspace-tools.mjs:750`、`:757`、`:792`。
- 证据一：注入两页 PDF 解析结果，第一页段落 25,000 字符。工具只返回 page 1 分隔符，正文未返回，却提示 `next_page: 2`，第一页永久跳过。
- 证据二：真实 DOCX 含一个 30,000 字符段落，结果仅 93 字节的成功说明/头信息，`truncated: true`，没有 next offset；传入 `byte_offset` 仍得到相同结果。
- 影响：C6-10/C6-15 的可续读保证不成立。按 page+1 续读仅适用于整页已完整输出的情况；原文本长行修复没有推广到新格式。
- 修复验收：定义可在页内、块内推进并绑定文件版本的游标；多段输出应重建所选内容，无遗漏、重复和空转。PDF probe 使用假 loader，以隔离渲染/分页缺陷，并非真实 PDF parser 压测。

### A08 · P2 · 解析达到限额时可能静默丢弃内容

- 位置：`agent-runtime/src/pdf-adapter.mjs:285`、`:318`；`agent-runtime/src/docx-adapter.mjs:146`。
- 证据：注入单页 2100 行，PDF adapter 只返回 2000 blocks，但 `partial: false`、`warnings: []`。最后一页内达到上限后，没有下一页触发外层告警。`pages_read` 取计划页数而非实际完成计数。
- 补充静态发现：Word 表格裁列和裁单元格文本不计入 truncated，只有裁行计入；`MAX_DOCX_CELL_BYTES` 实际按字符串长度裁剪，不能保证 UTF-8 字节预算。
- 影响：用户和模型把残缺内容当完整内容，违反 C6-15/C6-19/C6-20。不是仅有展示文案差异。
- 修复验收：每个截断点都产生诚实状态、原因和实际进度，覆盖恰好边界、最后一页、单页超限、多字节文本、超宽/长单元格。

### A09 · P2 · Word transform 批准后不重验源版本

- 位置：`agent-runtime/src/docx-tools.mjs:206`、`:345`、`:405`。
- 原因：读取时保存 source identity，后续没有用于版本核验；提交前仅检查 destination。
- 证据：通过真实 PermissionBroker 等待批准，在期间将 source.docx 改成不同内容，再 Allow；结果成功并创建 changed.docx，没有 stale 错误。
- 影响：批准基于旧源版本及其 fidelity warnings，无法保证新产物所声明的来源；P4 task 7 明确要求绑定 source version。此问题不会把源文件改回旧版，也不是同路径覆盖，严重度据此定为 P2。
- 修复验收：把源身份/版本纳入批准和提交校验；源变化时拒绝并重新准备预览，证明 source 和 output 不产生非预期变更。

### A10 · P2 · workspace 跨段版本与 search continuation 仍未实现

- 位置：`agent-runtime/src/workspace-tools.mjs:447`、`:838`、`:888`。
- 证据：先读 30,000 字符 A 的文件，得到 `next_byte_offset: 24064`；替换为 31,000 字符 B 后续读仍成功，返回新版本 B，没有 stale code 或绑定旧版本的请求字段。search 的两个匹配文件设 `max_results: 1` 后只返回 1 个、`truncated: true`，没有 next/cursor/offset 字段。
- 影响：模型可能拼接不同版本，或只能重跑同一搜索。P2 task 4 和 C6-10 明确要求不失去目标身份的续读；“search review 未做”没有正式处置这两个要求。
- 修复验收：为文本/目录/搜索明确版本变更语义和游标协议；对变更时拒绝/重启行为以及超过一页的穷尽遍历增加断言。若另行收束，必须显式修改要求及其残余风险，不能沿用现有全满足结论。

### A11 · P2 · UI 状态与 runtime 事件顺序矛盾

- 位置：`agent-runtime/src/runtime.mjs:1000`、`:1033`；`src/App.tsx:606`、`:621`、`:628`、`:797`；`agent-runtime/src/permission-broker.mjs:294`。
- 静态可确定的事件错误：runtime 先发 `workspace_overridden` 再发 `run_started`，UI 在后者把 override 清掉。因此任务开始后覆盖警告消失。
- 静态可确定的状态错误：`run_waiting` 设置等待状态，但 UI 没处理 `permission_resolved`；点击 Allow/Deny 只移除 permission card。等待状态直到 terminal 才清除，操作/模型恢复后仍显示 “Waiting for you”。
- 影响：违反仍保留的 C6-40；这不是已延后到 Cycle 7 的键盘/布局质量审计。
- 修复验收：按真实事件顺序测试状态投影，覆盖 override→started 和 waiting→resolved→tool result→继续生成；补桌面观察。本项为代码路径审查，本次未操作桌面 UI，未声称截图复现。

### A12 · P2 · 实际 MCP 配置加载路径绕过 server 数量上限

- 位置：`agent-runtime/src/mcp-config.mjs:39`、`:323`；`agent-runtime/src/mcp-runtime.mjs:74`、`:85`。
- 原因：批量校验器规定最多 8 个 server，加载文件的真实路径却只逐个调用单项校验器。
- 证据：将 9 个合法 server 定义交给 loadMcpServerConfigs，9 个全部进入结果，diagnostics 为空。
- 影响：数量有界的契约失效，叠加顺序 discovery 和 A06 会扩大启动等待及进程资源开销。配置来自可信用户，不将其描述为远程权限突破。
- 修复验收：在实际入口执行批量上限和有界配置读取，超限结果可诊断、built-ins 仍可使用；覆盖 8/9 个及大文件边界。

## 3. 设计原则与取舍

### 值得保留的设计

- Context 被动采集、Runtime 主动执行、Policy 独立表达；单一 per-run registry 避免不同能力绕出第二条执行链。
- effect/scope/egress/source/replay 分离，比简单 read/write/external 更准确；对 MCP 明示用户启动的外部代码不是沙箱，这是正确边界。
- PDF 只读、Word 生成新文件并提示 fidelity loss，削减了难以证明安全的格式保真和替换工作。保留源文件的产品方向合理，A02/A09 是落实缺口。
- 第一方能力不提供 shell、任意 fetch 或进程执行兜底，缩小了审核面；MCP transport 启动用户配置的进程是另一个明确的信任边界。
- typed failure、单次权限、持久会话和本地假服务器测试提供了可维护的基础。审查没有发现需要推倒这些设计的证据。

### 需要修正的设计表达与验证方式

1. **统一 envelope 不等于统一内容契约。** A03/A04/A07 都发生在适配器对象转成模型 content 的过程中。应将“模型实际看到什么”设为正式边界，按内容守恒、顺序、定位、截断、续读逐项验证。
2. **取消属于整个 run。** 当前对工具执行的 timeout/abort 覆盖不了 discovery 和 provider 启动之间的等待，也覆盖不了同步解析。A06 不能靠 terminal 显示 cancelled 修复。
3. **最后一次检查不等于原子提交。** A02 需要 OS 提交语义。审批时源版本、目标状态、具体操作与 effect 的绑定需要完整闭环。
4. **Policy 的强制力需表述准确。** `runtime.mjs:565` 先调用 implementation.execute，`:583` 后消费 grant 检查成功。它是执行后的授权证明核验，并非中央 pre-effect 防火墙。当前 shipped write/MCP adapters 自身先审批，本次未发现因此绕过审批；但新增 adapter 不能只依赖事后检查。建议将敏感 effect 收敛到要求 grant 的可信执行接口，或明确 trusted adapter 义务并审计。
5. **默认 MCP classification 按名称绑定是已记录的降级。** C6-I030 明示风险，且 user_mcp 每次仍须批准，不能说它取消了授权。不过 schema 变化后旧风险标签可能误导，应在接收计划中绑定 digest 和重新确认。
6. **C6-42 应验证能力来源和暴露路径。** 内置 registry 不暴露 shell/fetch 是可检验承诺；不能把 faux MCP 工具名的 regex 断言扩大为“任意用户 MCP 服务器都不可能执行 shell”。MCP 内部效果不受 Aside sandbox 约束，C6-I006 已承认这一点。

### G01 · 解析响应性尚无充分证据

P3 已坦承 C6-19 event-loop measurement 未完成。PDF 的 Promise.race/destroy 能测试异步取消，不足以保证 Node 中的同步 PDF 解析不会占满事件循环；Word 的同步解压/XML 解析也需要对应预算证据。

本次证实的是 A01 的参数循环和 A08 的结果限额问题，**没有用恶意 PDF/ZIP 证明另一个解析器漏洞**。这里的结论是“硬时限和响应性承诺未被证明”。应记录代表性复杂/超限输入下事件循环延迟、取消耗时、内存和输出上限；需要时将解析放入可终止 Worker/子隔离单元。仅给 Promise 设置 timer 不能作为关闭依据。

## 4. 范围变更的合规性与一致性

这里的合规性是对本项目已记录的需求、决策和验收规则的符合性，不是外部法规认证。审查采用四个条件：有明确决策、旧要求被明确处置、PRD/计划/矩阵同步、残余义务有接收者和验收标准。

| 决策 | 审查判断 | 仍需履行的条件 |
| --- | --- | --- |
| C6-I009 Word 仅新文件输出 | 合理且已同步 PRD/C6-24，范围收束有效 | 不覆盖并发新目标仍是强制承诺，A02 不可借 deferral 豁免 |
| C6-I020 Cycle 5 manual 从 M0 移到 P7 | 顺序调整明确，未将未执行记作通过 | 26 项仍待执行；M2 单次成功不能代替全部桌面条件 |
| C6-I021 workspace 按 conversation session 延续 | 有明确语义决策及 session 切换测试 | 不等于已交付新会话管理 UI；启动目标和歧义仍需验收 |
| C6-I022/I024/I033 设置、会话管理、配置 reload/UI 后移 | 文件配置+重启可以构成较小开发版范围，有 I033 补充决策 | 接收任务仍需落地；P7 task 7 的旧“待决定”状态应同步 |
| C6-I026 撤销 Web Search/P5/C6-26…30 | 合理，PRD retired 明确，未发现隐藏第一方 search 要求 | 不把 retired 数量算成通过；live MCP/registry 边界继续成立 |
| C6-I030 classification digest 可选 | 有记录、每次批准仍在；可接受为明确的开发版风险 | 不能声称 schema 变化会自动使所有旧 classification 失效 |
| C6-I031 前端自动化基础设施后移 | 记录了缺口，可作为工作安排 | 不能免除 C6-40 的真实状态要求；A11 仍必须修复并验证 |
| C6-I034 packaging/install 和交互质量移到 Cycle 7 | supersede 原决定的记录完整，closeout≠release 表述合理 | 不得连带豁免 C6-19/C6-40/C6-44/C6-45；交互质量中的 streaming/restored-history 与功能回归有交叉，必须保留功能验收 |
| P2 search/changed-identity continuation | 未找到足够明确的要求处置 | “search review deferred”未关闭 task 4/C6-10，A10 仍属本轮 |
| P3/P4 faux-agent 阅读/总结/警告工作流 | 子计划承认未完成，但矩阵不足以覆盖最终链路 | A03/A04 证明不能只以 adapter 单测替代；补全工作流或明确处置非必要任务，保留产品要求 |

**关于包装任务来源的纠偏：** C6-I034 以“原 PRD 没提安装包”说明它不该进入本轮，这不足以单独证明原加入过程不合规。C6-I010 曾被明确接受，当前会话中用户也曾要求按 repo review 更新执行计划。后续被接受的计划可以扩展原 PRD，合理的依据是“范围重新协商并由 I034 取代”，不是“原 PRD 没有，所以过去的义务从未成立”。这不否定现在将安装包移到 Cycle 7 的决定。

## 5. G02/G03 · 收尾证据与文档状态

### 手工验收仍然阻塞验收完成

MANUAL-ACCEPTANCE 是未执行的工作清单，包含从 Cycle 5 承接的 26 项。已记载的 9 月 17 日 M2 文件读写成功，只能支持该次 happy path；root/target 分离、歧义恢复等不能自动推定通过。C6-45、C6-40 的真实 Windows 观察和 MCP 手工 smoke 仍需要证据。

本次没有操作运行中的桌面、真实 provider、第三方 MCP server 或安装包。安装版验收已移出本轮；其余保留项应由对应手工记录完成，不能在审查报告中代填。

### 审查时发现的文档矛盾

1. PLAN 首行称 P7 task 12 尚未完成，P7 后文已记录 Done；P7 的 “Development is not finished. Four tasks are open” 及 task 7/15 状态又与新决定不同步。
2. 矩阵一方面写 manual 未执行，另一方面写 PRD release boundary “is met”；PLAN 亦出现 “met in full”。§19 含 manual，不能同时成立。本次将执行索引和矩阵总述改为 audit-blocked，保留历史记录供追溯。
3. 矩阵汇总与行级标记不一致：C6-09/12/13 被列 auto-only 却含手工引用；C6-15/19/43 被列 auto+manual，行级却为 auto-only。C6-43 仍写 318，当前为 328。下一次正式验收前应逐行对齐，不能仅修总数。
4. README 开头还写 PDF/Word/Search planned for Cycle 6，与后文已移除 Search 的 roadmap 冲突。
5. C6-I013、C6-I026 consequence 6 仍误称没有用户 MCP 就没有 `permission_required` 能力；内置 workspace.write/edit、document.create/transform 的 write policy 也会产生该决定。
6. P2 的历史 “src 下无 child_process/spawn/fetch” 不能充当当前全局结论，MCP 已加入进程 transport；应限定为 workspace 第一方执行路径及当时版本。
7. Cycle 7 有多处口头归属，但当前没有接收计划。I017 所说 packaging “仅缺网络、无需其他工作”也不受代码支持：`scripts/stage-runtime.mjs:114` 的 runtime dependency roots 漏了 PDF 实际动态导入的 `pdfjs-dist`，脚本还引用不存在的 `scripts/stage-node-bin.mjs`。这些是 Cycle 7 接收风险，本次未运行 staging 或断言安装产物通过。

上述旧状态不应被批量覆写为“已修复”。C6-I035 记录新结论；正式修复/验收时逐项提供证据并关闭。

## 6. 本次验证及其局限

| 验证 | 结果 | 能证明什么 |
| --- | --- | --- |
| `npm.cmd run runtime:test` | 328/328 通过 | 当前已有 runtime 测试未回归；不能覆盖新反例 |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline` | 37/37 通过 | 当前 Rust 单元测试通过 |
| typecheck、build、cargo fmt --check、cargo check --offline | 通过 | 当前类型/构建/格式/编译检查通过 |
| `git diff --check` | 通过 | tracked 工作树无空白错误；不覆盖 gitignored docs |
| `node docs/cycle-6/AUDIT-REPRO.mjs` | 14 个诊断 probe，输出见 JSON | 复现 A01–A10/A12 涉及的边界缺陷；脚本退出 0 表示取证完成，不表示产品通过 |
| A11 UI 事件和 provider 序列化 | 静态路径审查 | 可确定状态/内容流错误，未替代桌面或真实网络运行 |
| 历史重复 10 次 runtime/5 次 Rust/15 次 MCP | 文档记载，本次未复做该次数 | 当前重新跑绿不能独立验证过去所有重复执行的历史 |
| 桌面/真实 provider/第三方 MCP/clean-profile 安装 | 本次未执行 | 不作已通过声明 |

探针在临时目录生成文件并清理；无网络请求。DOCX 使用项目 fixture 生成真实 zip/docx，源版本用真实 PermissionBroker 测试；PDF 输出边界用 fake loader 隔离，死循环用带 2 秒外部终止的独立进程；并发覆盖通过 filesystem seam 注入后调用真实 rename。MCP 使用连接/factory seam 和 faux provider。测试 seam 的使用范围在此明确，不把它们描述成真实外部服务验证。

重读旧测试变更未发现“批量削弱断言以凑通过”的证据：部分导入/分层迁移，以及 DOCX 从 unsupported 变 supported 后的二进制 fixture 调整有合理原因。问题主要是缺少跨层性质测试，重复运行已有测试只能发现不稳定性，不能补足这种覆盖缺口。

## 7. 收尾顺序与下轮计划建议

本报告是审查快照，唯一执行索引仍是 [PLAN.md](./PLAN.md)。建议按可独立验证的结果拆分修复，不再把“最后的一切”装进 P7：

1. **运行及数据完整性：** A01/A02/A05/A06，分别确保不会卡死、不会覆盖并发文件、坏 MCP 不拖垮 built-ins、Stop 后不发请求；每项先补针对反例，再修实现。
2. **模型能够完成文档/MCP任务：** A03/A04/A07/A08/A09/A10，验证从文件/服务器到最终 provider 内容的闭环，包含权限等待期间变化和多段读取。
3. **状态与资源边界：** A11/A12/G01，补事件状态测试和代表性解析响应性证据；完成后跑一次全门禁，只有时序问题才追加针对性重复。
4. **验收与旧 cycle 收尾：** 对齐矩阵与当前实现，执行 retained Cycle 6 Windows 清单和 Cycle 5 的 26 项；将阻塞/失败留在台账，分别记录 Cycle 5 遗留验收结论与 Cycle 6 验收决定。不得把本轮完成写成 Cycle 5 已发布或已有安装版。
5. **明确接收：** 给 packaging、settings/config reload、conversation management、digest 绑定、frontend 基础设施/交互质量建立接收任务，包含交付物、前置条件和测试。Cycle 7 不宜直接承接一个与本轮同样宽的“大产品化包”。

工作量失衡的根源是按技术层 P0–P7 切分，而不是按用户结果拆分；P4 含读取、生成、转换、权限、验证、保真、压缩包安全，P6 含配置、协议生命周期、schema 接收、风险分类、许可、净化、取消、UI，每一个都接近独立 cycle。P7 又承接跨层遗漏、基础设施和未做验收，导致“写完代码”与“完成要求”分离。

下轮建议每个交付单元只承诺一个可演示结果，例如“开发机以外能启动并完成一次文档读取”或“用户能配置一个服务器并使变更生效”。每单元同时估算实现、异常/边界、集成测试、手工证据及文档维护；把协议/依赖不确定性提前做限时 spike。没有实际用时记录，本次不编造人日估算。只有当保留范围的证据闭环后，才进入验收签署。
