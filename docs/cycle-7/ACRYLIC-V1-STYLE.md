# Cycle 7 版本 A：整窗原生 Acrylic

> 当前源码与版本沿革见 [FRONTEND-REVIEW.md](../FRONTEND-REVIEW.md)。本文“8px”是旧视觉记录的称呼；
> Rust 实际只传入 `DWMWCP_ROUND` 偏好，没有向系统指定数值半径，也不能保证透明窗口的最终外角。

**存档：** Git 提交 `ffd8780`，标签 `cycle-7-acrylic-v1`。本文件中的行号均指该标签里的文件；后续版本的同名文件行号会变化。可用 `git show cycle-7-acrylic-v1:src/App.css` 查看原样。

## 实际视觉构成

- 整块 Tauri 窗口采用 Windows/DWM Acrylic；主面板与收起控件都铺满各自的原生窗口，没有透明的“分岛”间隙。
- CSS 的 `rgba(247,248,252,.35)` 是覆盖在原生材质上的浅色染色，**真正的桌面模糊来自原生 `windowEffects`**，不是 CSS。
- 主面板与竖控件的窗口外轮廓采用 DWM 8px 圆角偏好；内部卡片、按钮可以有独立圆角，但不能改变整窗 Acrylic 的作用范围。
- 主面板作为一整片全高表面，适合推开目标窗口并排处理任务；常驻桌面时视觉体量较大。

## 手调参数索引（存档版本）

| 想调整的效果 | 文件与行号 | 当前值 / 作用 |
| --- | --- | --- |
| 原生桌面模糊 | `src-tauri/tauri.conf.json:25-27` | `windowEffects.effects = ["acrylic"]`；这不是 CSS 参数。 |
| 整窗系统投影 | `src-tauri/tauri.conf.json:24` | `shadow: true`。 |
| 窗口透明与无标题栏 | `src-tauri/tauri.conf.json:21-22,30` | `decorations: false`、`transparent: true`、透明背景。 |
| DWM 外角 | `src-tauri/src/window_corner.rs:16-27` | 属性 33、值 2；8px 是系统圆角偏好，不能通过 CSS 改它。 |
| 浅色染色 / 透光程度 | `src/App.css:10` | `--glass: rgba(247,248,252,.35)`。alpha 越大越不透。 |
| 亮边与内部阴影变量 | `src/App.css:11-12` | `--line`、`--shadow`；主要供弹层、输入框等内部组件使用。 |
| 主面板满铺和外角 | `src/App.css:68-81` | 宽高 100%、无外边距、8px 圆角、`--glass` 背景；无外层 CSS 阴影。 |
| 顶部图标按钮与选中态 | `src/App.css:101-118` | 白色半透明底、内高光、轻阴影；选中时近黑实底。 |
| Capture / 恢复布局 / Retry 按钮 | `src/App.css:138-150` | 浅白底、14px 圆角、轻投影与 hover。 |
| Context & activity | `src/App.css:161-172` | `#ffffff38` 半透明底、18px 圆角和亮边。 |
| 对话区域 | `src/App.css:248-299` | 自身不另铺满屏背景；用户消息气泡独立白色半透明底。 |
| 权限卡 | `src/App.css:329-414` | 高对比暖白底；Allow 近黑、Deny 浅色按钮。 |
| 附件卡与 JSON 预览 | `src/App.css:434-575` | 附件卡浅白底；预览弹层有独立阴影。 |
| 输入岛与发送按钮 | `src/App.css:578-624` | 白色输入框；近黑发送按钮的内高光与底部厚度阴影。 |
| 收起竖控件 | `src/App.css:625-648` | 整窗满铺、8px 圆角、`--glass` 染色；hover alpha `.4`。 |
| 出入淡入 / 指示灯脉冲 | `src/App.css:676-705` | 仅 opacity 动画；`pulse` 用于运行指示，并非材质发光。 |

**“发光”的准确含义：** 此版没有面板周围的霓虹光晕。按钮亮感主要来自 `inset 0 1px` 内高光；键盘焦点来自 `src/App.css:45-48` 的 outline。修改 `--shadow` 不会改变 DWM Acrylic 的模糊强度。

## 边界

若在这一版本直接给主面板加外边距、大圆角或把控件拆成多个不相连的 CSS 岛，原生 Acrylic 仍会覆盖完整窗口，透明间隙不会成为真正的透明桌面。这个版本作为原生模糊路线的稳定对照保留。
