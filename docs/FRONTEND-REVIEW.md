# 前端复查：当前实现、接口展示与证据

状态：**R1 轻量视觉修正完成，R3 已实现 FE-08 动态焦点 Capture；C8 P1 / P2 已新增模型 / API 和默认目录设置，沿用原侧栏布局。真实桌面与完整原生验收仍未执行。** P0/P1 已提交为 `b5a0bd1`，P2 留在工作区。R2 自动化复核见 [复核记录](./cycle-6/R2-RECHECK.md)，本轮集成见 [R3 记录](./cycle-6/R3-INTEGRATION.md)；既有人工验收与安装包的无限期延期不变。

要求见 [SUMMONED-SIDEBAR.md](./design/SUMMONED-SIDEBAR.md)，阶段与问题状态见 [RECOVERY-PLAN.md](./RECOVERY-PLAN.md)。此前误删的快捷键自动分屏与原窗口恢复已重新实现；自动化证据的适用范围见第 7 节。

## 1. 当前到底用了什么

继续使用 **Tauri 2.11.5 / Rust + React 19 / TypeScript / Vite 7.3.6 / Windows WebView2**，没有迁到 WPF 或 WinUI。

| 层次 / 版本 | 实际配置 | 说明 |
| --- | --- | --- |
| 存档 A | `ffd8780` / `cycle-7-acrylic-v1`，原生 Acrylic、阴影与旧交互。 | 仅作沿革对照，不整体回退旧胶囊。 |
| R1 前的版本 B | 透明原生窗口、`shadow: false`、无 `windowEffects`，CSS 半透明分岛。 | 已被本轮替换；历史参数保留在 [PLATE-V2-STYLE.md](./cycle-7/PLATE-V2-STYLE.md)。 |
| 当前原生底板 | `transparent: true`、`decorations: false`、`shadow: true`、`windowEffects.effects: ["acrylic"]`、Light 主题。 | 透明 WebView 用于露出整窗原生底板，没有底板外的大块透明外边距。 |
| 当前组件 | `App.css` 后加载 `plate.css`；连续底板上使用白色消息气泡、输入、附件、权限和按钮。整个对话区透明，附件项不再叠加白色卡片。 | 主要交互组件统一 12px 圆角；滚动条借用右侧内间距，上下文 / 权限与底部输入同宽对齐。 |
| 原生外角 / 边缘 | `window_corner.rs` 请求 `DWMWCP_ROUND` 和 `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE`。 | 圆角是 DWM 偏好，不是指定 8px 半径；最终边缘、圆角与阴影仍未观察。 |
| 降级 | 读取当前窗口的 DWM backdrop 类型及系统透明度 / 高对比度设置，通过 `AgentState.material` 告知前端。 | 可确认 Acrylic 时露出连续底板；无法确认、系统禁用透明度或高对比度时使用连续实底。旧系统不能确认该 DWM 属性时也保守使用实底。CSS 另响应 reduced-transparency / forced-colors。 |
| JSON 预览 | 预览组件使用白色实底，遮罩无 CSS blur、无额外外框圆角。 | 不再用 WebView 内的 `backdrop-filter` 表达桌面磨砂。 |

依据是当前配置、锁定依赖的本地源码及原生调用；并非从旧截图推断当前效果。[版本 A 记录](./cycle-7/ACRYLIC-V1-STYLE.md) / 版本 B 记录保留为历史。官方 API 入口仍可参照 [Tauri WindowConfig](https://v2.tauri.app/reference/config/#windowconfig) 和 [Microsoft 原生圆角说明](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/apply-rounded-corners)，本轮自动化结果不验证 DWM 最终绘制。

## 2. 本次已经落实的交互

- 启动保持 `visible: false`。平时真正隐藏，没有胶囊、悬停预览、桌面小组件或原生窗口变形。
- 从隐藏状态按 `Ctrl + Alt + A`，先绑定前台窗口和工作区；对最大化、接近占满工作区或覆盖工作区的全屏目标保存完整 `WINDOWPLACEMENT`。一次性 capture 在后台执行，**完成后**才改变布局、显示并聚焦 Aside。
- 对可调整的候选目标，原应用占左 80%、Aside 占右 20%，按同一物理工作区互补取整，保持工作区全高；旧 340–520 逻辑像素限宽不再参与呼出布局。普通窗口保留原布局，Aside 使用相同显示器的右侧全高区域。
- 捕获尚未完成时再次按快捷键会取消本次呼出；旧捕获完成后不得重新展开或覆盖下一次呼出。连续的显式 `show_agent` 请求不重复开始采集。
- 再次快捷键、Esc、Hide 和关闭请求共用隐藏 / 恢复路径。Esc 仍先关闭 JSON 预览；收起后恢复已保存的同一原窗口 placement，包括最大化状态，并尝试归还焦点。正常进程退出也执行恢复收束；不承诺强制结束进程后的自动恢复。
- 原目标身份通过窗口句柄、进程及类标识复核；已关闭 / 身份失效时不操作替代窗口。目标拒绝排列或显示中途失败时尝试恢复；恢复失败保留原快照和可重试错误，不允许下一次布局覆盖它。目标拒绝 80/20 且回退成功时可显示侧栏，并明确报告降级。
- Win32 定位同步执行，按 DWM 可见边界校正不可见 resize border，移动到目标屏幕后再次计算边界；排列后核对实际位置，恢复后核对最大化状态。
- 展开期间保留最近外部焦点，点击 Aside 不覆盖它；显式 Capture 快照并复核此目标。原 `summon_target` 用于收起后的焦点返回，原 placement 快照用于布局恢复，两者都不随后续 Capture 改变。焦点事件不发给 runtime，也不触发后台内容采集。隐藏不取消任务；草稿、附件、权限、错误、流式结果与事件订阅保留，完成与审批事件不主动显示侧栏。附件成功发送后仍按既有逻辑从待发送区消费。
- Pin 保留。浏览器预览默认展开且使用实底，支持页面内相同组合键；它不实现系统快捷键、真实宿主采集或原生分屏。

没有增加失焦自动隐藏、独立分屏开关、桌面控件或第二套 runtime 协议。

## 3. 原生命令到界面的对应

`lib.rs` 继续注册 **15 个 command**。恢复通过现有 show / hide / toggle 生命周期完成，没有重新增加独立的 Workspace Mode 按钮。

| 接口 | 当前前端入口 / 投影 | 复查结论 |
| --- | --- | --- |
| `get_agent_state`、`agent://state-changed` | 初始化、快捷键同步、隐藏分支、`material` 降级投影。 | 保留事件优先于较晚初始化快照的处理；前端不持有原生窗口快照。 |
| `show_agent`、`hide_agent`、`toggle_agent` | 原生快捷键、Hide、Esc、关闭请求、浏览器预览。 | 自动采集 / 排列 / 恢复已接入原生生命周期；原生桌面闭环尚无观察证据。 |
| `set_pinned` | Pin / Unpin 与 pressed 状态。 | 保留。 |
| `capture_active_host_context`、`host://capture-completed` | Capture、宿主 / 策略、附件、路径描述符、JSON 预览、定位与移除。 | 初次采集先于布局和焦点变化；重新采集使用最近外部目标，不拆散布局或替换恢复快照。不可用目标不回退采集旧宿主。 |
| `runtime_prompt` | 输入、发送、流式、历史、错误和适用时的 Retry。 | 发送失败保留草稿，尊重 `retryable: false`。 |
| `runtime_cancel` | Stop 与取消状态。 | 隐藏不调用。 |
| `runtime_permission_response` | 解释、目标 / 预览、边界、到期时间、Allow once / Deny。 | 保留 request/task/tool-call 身份；等待真实解决事件，发送失败可重试。 |
| `runtime_set_workspace`、`runtime_clear_workspace` | 路径输入、Set / Clear、来源、根目录与 target、覆盖提示。 | 文件 workspace 与原生窗口布局仍是两个概念。 |
| `get_active_window_state`、`get_active_host` | 诊断查询；宿主信息也随 capture 返回。 | 没有独立查询按钮。 |
| `move_agent`、`resize_agent` | 保留的低层定位接口，界面不调用。 | 没有手动移动 / 缩放把手；不能宣传为用户功能。 |
| `get_settings`、`save_settings`、`set_api_key` | 头部设置按钮，provider / model / Base URL，key 独立写入 / 删除；显示来源和环境覆盖。 | 模型不 ready 也可打开；不读回 key，普通保存不清掉未提交 key。 |
| `get_provider_catalog`、`test_api_connection`、`apply_settings` | 后端受支持模型与能力、显式测试、空闲应用与实际状态。 | 测试前说明有效端点和少量用量；当前任务继续，协议等落盘后重建。 |

## 4. Runtime 事件到界面的对应

| 事件组 | 当前投影 |
| --- | --- |
| `ready` | provider/model、skill 名单及全部加载诊断；ready 不代表验证了网络连通。 |
| `history_restored` | 对话恢复；隐藏期间保持订阅。 |
| `session_warning`、`runtime_warning`、`runtime_unavailable` | 错误；断开时清理过期等待、权限与环境状态。 |
| `workspace_resolved/unresolved/cleared`、`run_started.workspace_overridden` | 根目录、实际 target、选择来源、覆盖事实。 |
| `skill_activated/cleared`、`run_started.active_skill` | 当前 skill；不沿用上一轮状态。 |
| `mcp_servers`、`run_started.tools` | 全部配置项、disabled / 信任状态和实际工具来源；配置不代表连接。 |
| `tool_call_started/update/result` | 按 call ID 对应最近活动；可展开有界输入和实时 / 最终输出，显式标注截断。 |
| 结构化 `tool_result.details` | PDF / Word 返回块数、加载页数、续读位置、警告、输出名 / 完整路径 / 来源 / 结构 / 重新打开验证与定位。 |
| `permission_requested/resolved`、`run_waiting` | 审批卡片、等待、发送中禁用重复决定、发送失败保留卡片。 |
| `verification_started/completed` | 工具、路径、状态；终态后保留验证结果。 |
| `text_delta`、`completed/cancelled/failed` | 回复、终态、截断与适用的重试；不自行展开侧栏。 |
| `configuration_status`、`runtime_reconfigured` | 设置页刷新实际应用状态；聊天保留历史 / 草稿 / 附件，清理旧权限 / 工具 / skill 投影，新 ready 随后更新。 |

策略元数据仍由 runtime 执行；P1 / P2 新增基础设置与默认来源 / 输出说明，完整工具时间线仍未提供。

## 5. 确实还没有的功能

- Skill 手动选择：runtime 内部方法存在，但 stdio 与 Rust 请求尚未贯通；R4 明确为后续功能。
- P1 / P2 已实现 provider/model / 凭据编辑、默认目录与产物定位、显式空闲应用；思考控制、会话切换 / 新建、MCP 配置编辑仍按 C8 P3–P5 推进。当前只恢复单一活动会话，不支持任务中途任意热替换。
- 完整工具轨迹、手动移动 / 缩放、隐藏通知：本轮未提供。
- 长期 memory、自整理、Mac capture、外部 agent：后续范围；Codex / Claude Code 适配继续延后。

## 6. 剩余窗口边界

底板已覆盖完整原生窗口范围，内部间距露出同一底板；不再设计透明岛间穿透。原生窗口可见边界校正已有代码与纯几何测试，但真实 DWM 可见边界、四角、系统阴影、焦点限制、混合 DPI、目标最小尺寸 / 拒绝布局、独占全屏应用及实际快捷键冲突尚未做桌面观察。

浏览器检查只能验证 CSS、交互投影与滚动；不能证明 Acrylic 生效、真实窗口排列 / placement 恢复或全部 Windows 宿主都可调整。正常退出与可恢复错误有清理路径，进程被强制终止、系统崩溃不在本轮自动恢复保证内。

## 7. 本次开发证据

本节保留 R1 的开发检查；R3 当前结果见第 8 节。这些证据不表示安装中的桌面程序已经被替换或启动。

| 检查 | 本次结果 |
| --- | --- |
| `npm.cmd run frontend:test` | **23 项通过**；保留原 21 项隐藏 / 运行 / 权限 / 上下文 / 结果回归，新增材质降级保留草稿和恢复失败后隐藏状态 / 错误保留。 |
| `npm.cmd run build` | 通过，包含 TypeScript 与 Vite 生产构建。 |
| `node_modules/.bin/tsc.cmd --noEmit --jsx react-jsx --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --strict tests/island.test.tsx` | 通过，测试夹具与新增 `material` 契约一致。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline` | **41 项通过，无编译警告**；包含全屏候选、边框校正、精确互补布局、失败恢复保留快照、取消与过期呼出请求。未调用真实宿主窗口进行验收。 |
| 无头 Edge / 合成 Tauri 事件 | 视觉修正后重跑 384×1040、256×720、320×600、256×480 CSS 像素四种尺寸通过；256 宽用 1.5 像素密度。整个对话区透明，双方消息气泡白色实底，主表面同宽且主要控件均为 12px 圆角；附件 / 审批分阶段检查，无页面横溢，输入保持可见，短屏可滚动。 |
| 截图与检查数据 | 本地忽略目录 `.cache/r1-ui/` 的 8 张截图、`layout-check.json` 与合成检查脚本；已检查标准、窄宽度与短高度图。它们是浏览器实底回退版证据，不能作为原生 Acrylic 截图。 |
| 格式与文档 | 改动 Rust 文件 rustfmt、`git diff --check` 通过；79 份 docs Markdown 加根目录 2 份文档共检查 443 个本地链接、97 个锚点，无错误，FE-01–07 / A01–12 主跟踪行唯一。 |

失败与修正也保留：`npm.ps1` 被 PowerShell 执行策略拒绝，改用 `npm.cmd`；Cargo artifact lock、Vitest 临时文件和部分源文件写入被沙箱拒绝，工具授权后执行。第一轮 Rust 检查产生两处未使用 capture 包装函数警告，清理后最终无警告。浏览器脚本先修正本地 404 处理，再修正合成键入和附件发送后已消费的夹具假设；这些不是产品测试通过记录，最终分阶段检查才通过。

此前 21 项前端 / 40 项 Rust、独立类型与生产构建结果继续作为历史开发证据；旧逻辑限宽测试已由 R1 互补布局测试取代。试用后的轻量视觉修正重跑 23 项前端回归、生产构建及四尺寸浏览器检查，该次没有改原生代码。A01–A12 / G01 的 R2 结果另记原 issue，C6-40 与历史人工验收仍不自动完成。

## 8. R3 动态焦点与集成开发证据

2026-10-31：`platform.rs` 在主事件线程安装前台窗口监听并于正常退出卸载，只保留最新外部窗口元数据；`commands.rs` 的显式 Capture 使用该目标，收起后的焦点返回仍使用独立 `summon_target`。监听失败时显式 Capture 返回可恢复错误，不静默退回旧目标。没有新增前端组件、轮询或 IPC 事件。

完整 Rust 库测试 **45 项**通过，新增 4 项覆盖外部目标更新 / Aside 焦点保留、外部不可用时清空、进行中的采集快照不变，以及原恢复快照 / 失败重试保持独立。runtime **388 项**、前端 **23 项**、TypeScript 与生产构建通过；PDF/Word、权限、结果及 Windows 合成文件测量见 [R3-INTEGRATION.md](./cycle-6/R3-INTEGRATION.md)。

本轮没有启动桌面程序或重做材质 / 四尺寸视觉检查；CSS 未在 R3 修改。实际先呼出→切换文件夹→回 Aside Capture→收起恢复仍待桌面复测；完整人工与安装包验收继续延期。

## 9. R4 诊断投影证据

2026-10-31：MCP discovery 诊断此前停留在 controller；现在经已有 `runtime_warning` 到达界面。未绑定 / 绑定失效会说明保守回退和复核配置要求；界面使用现有最新通用错误区域，没有新增组件或设置页。新增回归验证警告先于 `run_started` 到达，跨隐藏、后台完成和重新展开仍保留。

本轮最终 24 项前端、394 项 runtime 及 TypeScript / 生产构建通过；细节见 [R4-RUNTIME.md](./cycle-6/R4-RUNTIME.md)。没有改前端实现、样式或原生窗口，也没有新增桌面 / 可读性人工验收。既有内部 skill 方法与未接入的产品入口继续按总计划区分。

## 10. C8 P2 基础目录与产物投影

设置中增加独立的默认目录卡片与保存、定位；API、目录和 key 草稿互不清空。activity 显示实际输出范围及只读捕获来源，文本 / JSON / Word 产物使用后端绝对路径定位；缺失路径由原生层报可恢复错误，不创建文件。原侧栏、底板与组件样式不变。

前端 41/41、类型与生产构建通过。无头 Edge / 合成 IPC 检查 384×1040、256×720、320×600、256×480 四尺寸：4 张卡片同宽、12px 圆角、无页面或控件横溢、短屏滚动；已目视复核标准和窄短屏的新增目录卡。12 张截图和数据位于本地忽略目录 `.cache/c8-p2-ui/`。这些是浏览器回退版证据，未启动真实 Tauri 窗口或 Explorer；完整后端证据与限制见 [P2](./cycle-8/plans/P2-default-workspace.md)。
