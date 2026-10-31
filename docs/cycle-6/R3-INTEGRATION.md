# R3 集成开发与自动证据

日期：2026-10-31。目标：基于 `ffd87807379a3016f9b09613c4ed5da775b539f0` 的未提交工作区，包含此前 R1 / R2 改动。状态：**R3 开发实现与自动证据完成；真实桌面焦点 / 恢复、真实 provider / Word 文档质量、完整人工与发布验收仍未执行。** 排期和遗留项以 [RECOVERY-PLAN.md](../RECOVERY-PLAN.md) 为准；本文只记录证据，不另立执行计划。

## 1. 本轮改动与可观察结果

| 项目 | 本轮结果 | 证据与范围 |
| --- | --- | --- |
| FE-08 动态 Capture | 最近外部焦点用于显式 Capture；点击 Aside 保留该目标。原窗口恢复和焦点返回仍绑定呼出时窗口。 | `platform.rs` 的前台事件监听、`commands.rs` 的独立 `summon_target`；4 项纯状态回归通过。原生事件的实际桌面到达及采集仍待复测。 |
| INT-01 工作区边界 | 已核对 UTF-8、字面查询 / 无 glob、无 ignore 过滤、大小写与预算；完成三档 Windows 合成测量。 | 2 项新回归；[R3-BENCHMARK.json](./R3-BENCHMARK.json) 保存环境、预算、耗时和返回边界。 |
| INT-02 PDF 工作流 | 采集描述符→workspace / target→PDF 正文与页码→摘要 / 问答；partial 警告、公开游标续读和只读格式写入拒绝。 | 4 项新 faux-provider runtime 集成，其中只读格式用例覆盖 PDF / Word × write / edit × auto / text 共 8 种组合，检查真正的 provider `toolResult.content`、无审批及源文件未变。 |
| INT-03 Word 工作流 | 已有 Word 摘要；保真警告到模型正文与审批预览；允许 / 拒绝转换。 | 3 项新 faux-provider 集成，检查一次审批、源文件逐字节保留、输出重开验证、路径与验证事件。 |
| 既有 MCP / 状态投影 | 当前完整回归继续包含真实 MCP adapter 到 faux provider 正文的检查，以及权限 / 隐藏 / workspace override / 结果组件回归。 | 本轮没有新增外部 agent 接入或真实 MCP 服务器试用；R2 与组件测试各自仍有原来的证据范围。 |

集成测试位于 [recovery-integration.test.mjs](../../agent-runtime/test/recovery-integration.test.mjs)。faux 的工具调用和最终回复由测试预设；本轮证明数据、审批、事件和文件结果能够贯通，不证明真实模型的摘要质量或页码推理准确率。

## 2. 动态焦点与恢复目标的边界

Windows 在主事件线程安装 `EVENT_SYSTEM_FOREGROUND` 监听，采用 out-of-context / 跳过当前进程的方式；正常退出在同一事件线程卸载。最近外部窗口的身份和几何元数据只保留一份在内存中，没有窗口切换历史、焦点 IPC 事件或持续内容采集。显式 Capture 调用复制目标并重新检查原生身份；后续切换不能重定向已经开始的采集。

Aside 自身焦点不清掉外部目标。外部窗口无法作为目标时清空旧目标；已关闭 / 句柄身份变化的目标交给现有采集契约明确失败，不改取另一宿主。监听未启动时 Capture 返回可恢复错误。呼出时的初次采集继续绑定原目标，并先于 80/20 排列和 Aside 聚焦完成。

焦点跟踪只影响新 Capture 的来源；既有附件仍显式保留，用户选择的 runtime workspace 仍按原优先级生效。多个附件带来竞争根目录时继续使用既有歧义提示，不自动按最近焦点改写文件 workspace。

原 placement 恢复快照与 `summon_target` 均不随新 Capture 改变；后者也涵盖不参加分屏的普通窗口，避免收起时归还焦点到新采集对象。原有取消 / 过期呼出、失败恢复保留快照的机制继续保留。以上代码与纯状态回归尚不能代替真实桌面的焦点、系统限制及宿主拒绝排列观察。

## 3. 工作区策略复核与测量

- 文本 / Markdown / JSON 只接受可解码的 UTF-8，非法编码返回 `unsupported_encoding`；未新增 GBK / UTF-16 等猜测。PDF / DOCX 由格式适配器处理，不等于普遍支持其他文本编码。
- 搜索查询是字面子串，`*.txt` 不作为 glob；没有 ignore 文件或隐藏目录过滤，`.gitignore` 也不会改变遍历。受既有 workspace containment 和预算约束，不把这些行为宣传为项目语义搜索。
- 名称与内容匹配使用现有 locale 小写比较；Windows 夹具验证当前临时目录中的大小写路径行为，不外推到大小写敏感卷、所有 Unicode locale 或全部网络盘。
- 默认单页目录 128 项、每次新增扫描 128 文件、最多 64 结果、深度 24；搜索单文件 64 KiB、普通读取 256 KiB、正文输出 24 KiB。大目录仍先枚举并排序，再返回分页；预算不是目录枚举或同步解析的硬时间上限。
- 修正 `mode: both`：当 PDF / DOCX 或不可搜索正文产生诊断时，仍保留已经命中的文件名称。内容未被当作文本解析。只读文档的 `workspace.edit` 在正文解析 / 审批之前返回 `unsupported_format` 和 `unsupported`，不再在缺少 `raw_text` 时抛内部异常。文本写入验证和编辑入口也保留路径原格式的只读约束，显式 `format: text` 不能绕过 PDF / DOCX 边界；Word 生成 / 转换仍走专门的 `document.*` 能力。

`npm.cmd run --silent workspace:benchmark -- docs/cycle-6/R3-BENCHMARK.json` 在 Windows `10.0.26200` / x64 / Node `v22.23.2` 上执行；本次与整体开发检查并发，耗时只是一次观测，不设性能阈值：

| 合成目录 | list / read / search 耗时 ms | 目录返回 / 搜索扫描与结果 | 输出与拒绝 |
| --- | --- | --- | --- |
| 32 文件，每个 64 B | 89.502 / 11.294 / 129.288 | list 32；扫描 32，命中 4，完整。 | 最大正文 4825 B。 |
| 512 文件，每个 1 KiB | 175.205 / 2.752 / 543.056 | list 128；扫描 128，命中 16，均给出继续游标。 | 最大正文 19215 B。 |
| 2048 文件，每个 1 KiB，另加 300 KiB 文件 | 93.430 / 1.719 / 405.733 | list 128；扫描 128，命中 16，均给出继续游标。 | 最大正文 19216 B；大文件 1.533 ms 内返回 `result_too_large`，不是通用延迟承诺。 |

JSON 中 `entry_count` 是实际目录页大小；`details_preview_entries` 是安全裁剪后的细节数组大小，二者分别记录。所有正文不超过默认 24576 B；该测量未执行桌面、provider、安装包或干净环境任务。benchmark 会清理它自己创建的临时目录。

## 4. 检查、初次失败与最终结果

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd run runtime:integration` | 最后补齐显式 format 边界后 9 / 9 通过；只读格式用例包含 8 种参数 / 格式组合。 |
| `node --test --test-timeout=60000 --test-reporter=spec agent-runtime/test/recovery-integration.test.mjs agent-runtime/test/workspace-tools.test.mjs agent-runtime/test/workspace-write-tools.test.mjs` | 第一轮修正后 53 / 53 通过；后续 format 修正由独立 9 项及最终完整 gate 覆盖，未重复此子集命令。 |
| `npm.cmd run runtime:test` | 388 / 388 通过；包含 R2 的 14 项复核与现有 MCP / 取消 / 权限等套件。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline` | 45 / 45 通过，无编译警告；新增 4 项焦点状态回归。 |
| `npm.cmd run frontend:test` | 23 / 23 通过。 |
| `npm.cmd run build` | TypeScript 与 Vite 生产构建通过。 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml`、`git diff --check` | 格式化与差异空白检查完成。 |

第一次新增集成运行 **6 / 9**：混合搜索漏掉 PDF/Word 名称匹配、PDF 编辑访问缺失 `raw_text` 是产品缺陷；长单行 PDF 夹具文本超出页面，被解析库正常裁切，不能用它构造输出截断。修正前两处实现，并改用全部在页内的多行双页 PDF。第二次 **8 / 9**：PDF 编辑已返回格式错误码，但外层状态仍为 `failed`；补齐 `unsupported_format` 到 `unsupported` 的映射后，定向 53 项与整体 388 项均通过。没有通过弱化断言掩盖产品缺陷。

随后扩充只读用例，定向运行 `node --test --test-timeout=60000 --test-name-pattern="read-only document edits" agent-runtime/test/recovery-integration.test.mjs`，在 `source.pdf / workspace.edit / text` 组合再次复现绕过：显式格式覆盖了由路径识别的只读能力。修正文本验证及编辑前置检查后，PDF / DOCX × write / edit × auto / text 的 8 种组合均无审批、源文件未变；独立 9 项和完整 **388 项**重跑通过。`.cache/r3/explicit-format-before.txt` 保留这次失败输出。

Cargo 构建锁、Vite 临时缓存和部分现有源码 / 测试 / tools 目录写入被沙箱拒绝，按工具授权后完成。它们不是产品回归失败；未把无法启动的测试计为通过。本地忽略目录 `.cache/r3/` 保留整体 gate 输出，长期可复跑证据为测试源码、本记录及 benchmark JSON。

文档校验覆盖 81 份 docs Markdown 与根目录 2 份文档：499 个本地链接、97 个锚点无错误，FE-01–08 / A01–12 / INT-01–03 主行与 C6-I037/038 标题唯一，8 份源码摘要与最终代码一致。校验脚本首轮误把 `A01` 生成成 `A-01`，造成编号误报；纠正脚本后通过，没有为此修改正确的原编号。

## 5. 源码摘要与仍未验证的内容

以下 SHA-256 对应本轮自动 gate 的最终代码；[R2-EVIDENCE.json](./R2-EVIDENCE.json) 的摘要保留为 R2 当时值，不再冒充本轮源码摘要。

| 文件 | SHA-256 |
| --- | --- |
| `src-tauri/src/platform.rs` | `0AAA3B794CE9052C1A3E4A514474D9CAB367FABFFA760BC6DA948C736A7789B0` |
| `src-tauri/src/commands.rs` | `492FD191E0C2E4D8B4E779C9BB9D0E44BDCCBE31F3A26F6CC425DD3DF8E3ACEC` |
| `src-tauri/src/lib.rs` | `E373A9306A982E1A355603955CAC92CF8C37C7A40E0801CF5E1F27AE6FC4D3E5` |
| `agent-runtime/src/workspace-tools.mjs` | `30DCF20360C7A50BE3EB6C07913915BF7B3AA1C6B63BACF6332B749FAA4CC73D` |
| `agent-runtime/src/workspace-write-tools.mjs` | `EF9A018E20BAA69564C344704BE3BE1AE3D4A68DBB0B319AC03D7A89CB3BD63D` |
| `agent-runtime/test/recovery-integration.test.mjs` | `5716A411F613F927023048449F778ABC2FCDBD6CD4EAD8D785D625544BDBA9F5` |
| `tools/workspace-benchmark.mjs` | `BB850004B0DE7A1D75EB9D69C6B2B759E2E69A385D79BCE2F4666A5B0CB01A75` |
| `package.json` | `1E980C5D73B6F1F66E9E65E3AA5F100B4EE7E703A105BBB164EABABEC2054C9A` |

FE-08 的先呼出→聚焦另一个文件夹 / 应用→回 Aside Capture→收起恢复尚无真实桌面观察；Acrylic / DWM / 混合 DPI 也未重测。G01 的同步加载 / 单次解析硬时间限制没有新增保证。Word 列表类型区分、MCP 分类持久化 / schema 变化再审批等仍按 R4 定范围。完整人工、安装包、干净环境和发布继续无限期延期；runtime 完整性尚未定义，也没有宣称已齐备。下一步回到主计划 R4。
