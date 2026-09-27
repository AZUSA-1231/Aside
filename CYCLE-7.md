# Cycle 7 — 岛状界面交付记录

## 当前窗口材质决定（取代下文早期实现与材质复核结论）

按用户提供的修复路线执行，验收由用户负责：

- 恢复 Tauri `windowEffects.effects: ["acrylic"]` 和 `shadow: true`，
  保留 `transparent: true`、`decorations: false`。
- 删除 `window_shape.rs`、`SetWindowRgn` 与所有 region 裁切调用。
- 新增 `window_corner.rs`，在启动、展开、收起的 `show()` 后调用
  `DwmSetWindowAttribute`：属性 33、值 2、长度 4 字节。
  失败时发送原生错误，不关闭已显示的窗口；不使用 `windowEffects.radius`。
- 主面板和收起控件均满铺窗口，CSS 圆角统一 8px、染色 alpha 0.35。
  收起控件 hover/active alpha 0.4，原生 48×144 DIP 布局不变。
- 外层不再使用 CSS backdrop-filter、边框、高光阴影或 scale 动画；
  出入动画只改变 opacity。内部卡片与网页内弹层样式不受此限制。
- 不重新引入 `set_focusable` 切换，不改变 runtime 功能或接口。

**本次只修改源代码及记录，未运行测试、构建、重启或界面验收。**
下文测试结果和截图观察属于早期版本，不作为当前修正的验收证据。

2026-09-26。本轮以本次会话授权为准：前端与桌面窗口壳更新，不修改 agent runtime 功能或协议。旧文档中的四态 hover/preview/pinned 方案不再是本轮执行计划。

## Cycle 6 遗留项处置

| 项目 | 本轮处置 |
| --- | --- |
| 安装包、干净环境安装、Cycle 5/6 全套人工验收 | 继续无限期延期；不以新版构建成功冒充通过。 |
| A01–A12 runtime 审计发现 | 保留原审计状态；现有 365 项 runtime 回归复跑全部通过，不改 runtime 源码。首次运行 364/365，第二次未复现，首次失败详情未完整留存，因此不宣称已完成归因。 |
| C6-I031 前端没有自动化验证 | 新增 Vitest + jsdom 组件交互回归，可运行 `npm run frontend:test`。 |
| A11 状态一致性 | 保留工作区覆盖通知，补充 permission_resolved 清除对应权限卡，覆盖过期情形。 |
| C6-40 前端可读性 | 新版统一重做并执行开发者视觉检查；完整人工任务矩阵仍未执行。 |
| 分类存储、设置热重载、MCP 配置、provider 设置 | 功能 backlog，不属于此次 UI 更新。 |
| Word/PDF/provider 的真实任务证据 | 保留未完成标记；本轮仅确认现有事件展示与回归，不扩展文档功能。 |

## 视觉锚点

来源为 WinIsland/vision/mockup.html 与同目录参考图：雾白玻璃、较大的连续圆角、1px 内高光、冷色轻阴影、近黑纯色主按钮。去掉绿色品牌装饰、重复状态栏、机器人头像与口号。保留有意义的操作图标和明确权限标签。

主面板 30px 圆角，内容卡 18–24px，220ms 减速过渡；CSS 半透明/blur、边框和阴影，无 canvas、着色器或持续指针轮询。使用原有 DWM Acrylic，并以简单 Win32 圆角区域裁切原生背景。支持 reduced-motion，降低透明度设置下使用实底。

## 交互与保留功能

- 启动即显示右侧垂直居中胶囊，置顶、不主动获得焦点。胶囊原生窗口 48×144 DIP，外边距随 DPI 缩放；收起时不会留下全高透明窗口拦截桌面。
- 点击胶囊或 Ctrl+Alt+A 展开；Esc、收起按钮、窗口关闭请求或再次快捷键回到胶囊。采用简单 CSS 出入过渡，原生窗口尺寸直接切换，不进行逐帧 native resize。
- 展开继续使用已有侧栏布局：工作区高度，约右侧 20% 宽度，沿用 340–520 物理像素宽度限制。保留 Pin、目标窗口并排与恢复；原来的自由拖动改为右侧锚定，属于本次明确的交互替换。
- 旧 IPC visibility=hidden 现在表示面板收起，胶囊仍可见。runtime 与事件协议未修改。桌面壳释放前台焦点时短暂隐藏原生窗口，随即非激活显示胶囊，保留原来的前台采集路径。
- 草稿、会话、正在执行的任务、权限请求在收起期间继续保留；只有 Stop 取消任务。
- 捕获附件、来源、路径、有效期、JSON 预览、移除与定位文件保留。Esc 优先关 JSON 预览。
- 权限展示 operation、effect、egress、外部边界、解释、目标、workspace、preview 和绝对到期时间；Allow once/Deny 仍传递原始身份，不改变授权规则。
- 工作目录设置与清除、skill、MCP 来源、覆盖警告、工具状态、文档部分提取、写出验证、重试与错误保留。非关键状态放入 Context & activity；重要警告自动展开，权限到达时滚入可见区域。
- 修复已有 exit_workspace 调用名与原生命令不一致；中文输入法组合期间 Enter 不会提交。

## 验证与边界

- `npm run build`：通过（含 TypeScript）。
- `npm run frontend:test`：6 项通过，涵盖草稿恢复、流式输出跨收起、Stop、Allow/Deny 的身份与预览、附件 JSON 的 Escape 优先级与移除、过期权限清理。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：39 项通过，新增缩放、负坐标显示器和极小工作区边界测试。
- `npm run runtime:test`：复跑 365 项全部通过；日志位于本地 .cache/cycle7-runtime-tests.log。
- Windows 开发版实机冒烟：启动胶囊、点击展开、输入框、Esc 收起、Ctrl+Alt+A 展开、圆角玻璃边缘已检查。浏览器预览用于前端排版检查，不当作原生焦点或桌面模糊证据。
- 尚未完成完整人工验收、安装验收、多显示器热插拔、不同 Windows 对比度/透明度配置下的视觉矩阵和真实 provider 全流程。上述范围不宣称发布验收通过。

本记录放在根目录以随代码可追踪；docs/ 与 WinIsland/ 仍遵循已有忽略策略。没有改动用户已有的 .claude/ 文件。

## 2026-09-26 窗口材质复核

用户截图暴露出两个问题：Acrylic 系统效果在 Windows 11 上形成灰色矩形底板，展开时 `set_focusable(true)` 触发了 Tauri 窗口样式重建，露出系统标题栏。对照验证结果：删除 `windowEffects` 后桌面可透过窗口；删除 focusable 切换后标题栏消失。最终选择纯透明 Tauri 窗口 + 半透明 CSS glass/blur + Win32 圆角 region。系统 Acrylic/Blur 不再使用，因为该路径不可控且对本视觉目标没有帮助。
