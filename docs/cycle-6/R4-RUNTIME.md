# R4 Runtime 范围与开发证据

日期：2026-10-31。执行总入口及有限完成条件为 [RECOVERY-PLAN.md 第 7 节](../RECOVERY-PLAN.md#7-当前范围下如何判定-runtime-齐备)，本文件只记录证据，不承担另一套排期。当前 RT-01–11 的有界开发与自动验证完成；产品级齐备、整轮人工验收和发布尚未成立。

## 1. 本轮范围与发现

保留当前 Pi-backed runtime；新增必需工作只有 POLICY-01。LIMIT-01 接受为 Word 读取不区分编号 / 项目符号的限制，设置、会话管理、热重载、MCP 编辑页与手动 skill 入口保留后续功能。没有改 frontend 样式、原生窗口或外部 agent 适配。

核对并修正四处实际缺口：

1. 未绑定 schema 的分类此前仍会降低 `effect` 等标签；只有 controller 诊断，不阻止覆盖生效。
2. schema 不符虽会回退，却没有单独的失效提示。
3. server 配置指纹只负责重建连接；新连接重新读取同一分类配置后，即使命令 / 参数已变，旧 schema pin 仍可能生效。
4. discovery 发生在每次运行时，启动时保存的诊断快照没有这些结果；运行中诊断没有发到界面，重复发现还会累计旧诊断。

## 2. 修正后的契约

- 每个用户分类需要同时匹配 `schema_digest`（16 位 hex）与 `server_fingerprint`（32 位 hex），配置校验归一为小写。
- 任一缺失 / 变化时使用 `execute / host / selected_content / non_replayable`；工具仍可用于明确审批的调用，旧低风险标签不再应用。
- 缺失发出 `mcp_classification_unbound`，变化发出 `mcp_classification_changed`；消息包含当前两个摘要和人工复核 / 更新配置的提示。
- 用户管理的 `mcp.json` 即持久批准记录。发现、逐次 Allow once、重启都不写回或自动批准摘要；复核后手动更新文件并重启才使用新 pin。
- discovery 诊断通过现有 `runtime_warning` 投影，controller 每次发现刷新诊断；现有界面保留最新通用警告。没有新增设置页或诊断时间线。
- 即使绑定有效，每次 MCP 调用仍经权限 broker；拒绝前没有 `tools/call`。外部服务仍是非沙箱的可信进程。

指纹只覆盖启动配置的 transport / command / args / cwd / 环境变量引用名称，不做二进制内容校验，也不把服务的真实行为证明为只读。schema 摘要来自 Aside 接受并转发的参数 schema；工具名称仍决定用户配置中的对应项。它们是分类失效边界，不是外部代码完整性或隔离保证。

使用方法和兼容性见 [runtime README](../../agent-runtime/README.md#mcp-classification-bindings)。原来不带摘要或仅带 `schema_digest` 的覆盖现在退回默认；无 MCP 配置的路径不受影响。历史 8–64 位任意 digest 校验收紧为实际使用的 16 位，格式错误仍按单服务配置错误隔离。

## 3. 回归与失败记录

本轮新增 6 项 runtime 测试，修改 3 项既有分类测试；新增 1 项前端事件时序测试。回归覆盖有效双绑定仍审批、未绑定 / 单绑定回退、命令 / 参数 / cwd / 环境引用改变失效、复用连接 schema 变化、诊断不累计，以及真实配置文件的两次重新加载、变更失效、显式重绑定和配置原文不被自动修改。faux provider 路径验证实际 `run_started.tools` 与 `runtime_warning`；前端验证警告先于 run_started 到达，隐藏完成后重开仍保留。

| 检查 | 结果与证据 |
| --- | --- |
| 修复前 3 份 MCP 测试 | 75 项，66 通过 / 9 失败；`.cache/r4/mcp-before.log`。直接复现未绑定仍为 read、单绑定仍生效；新字段尚未接受使其余新契约测试失败。不能把后者全称为旧产品缺陷。 |
| 修复后同一 MCP 定向命令 | 75/75；`.cache/r4/mcp-after.log`。 |
| `npm.cmd run runtime:test` | 394/394，0 失败 / 跳过；`.cache/r4/runtime-final.log`。 |
| `npm.cmd run frontend:test` | 最终 24/24；`.cache/r4/frontend-final.log`。此前 23 项也通过，后补时序测试后重跑。 |
| 独立前端测试类型检查 | 对 `tests/island.test.tsx` 运行 `tsc --noEmit --jsx react-jsx --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --strict` 通过；`.cache/r4/test-types.log`。 |
| `npm.cmd run build` | TypeScript 与 Vite 生产构建通过；`.cache/r4/build-elevated.log`。 |
| 文档 / 摘要 / 差异收尾 | 85 份 Markdown、523 个本地链接、102 个锚点、7 份源码摘要及 11 个唯一 RT 行通过；`git diff --check` 通过。当前 `/docs` 为 113 文件 / 82 份 Markdown。 |

定向命令：

```powershell
node --test --test-timeout=60000 agent-runtime/test/mcp-config.test.mjs agent-runtime/test/mcp-adapter.test.mjs agent-runtime/test/mcp-runtime.test.mjs
```

环境 / 工具失败也保留：写 runtime 源码及测试被沙箱拒绝，申请工具授权后同范围补丁成功；首次前端和构建因 `node_modules/.vite-temp` 写入 `EPERM` 失败，授权后通过。首次构建失败保存在 `.cache/r4/build-final.log`；首次前端错误留在本轮工具记录，其日志随后被最终回归覆盖，不称为仍保留的原始日志。上述是环境失败，不是产品测试失败。

本轮没有改 Rust，也未重跑 Rust；R3 的 45 项结果仍按 [原记录](./R3-INTEGRATION.md) 阅读，不能写成 R4 新执行。没有重新跑 Windows benchmark 或桌面应用。文档链接 / 锚点、摘要和差异校验另按上表记录。

## 4. 工作区与源码摘要

基线 HEAD：`ffd87807379a3016f9b09613c4ed5da775b539f0`；在既有未提交 R1–R3 工作区上继续修改，没有提交或创建分支。R4 代码范围为以下文件，表中 SHA-256 对应上述最终测试后的内容。R2/R3 历史摘要保持原值。

| 文件 | SHA-256 |
| --- | --- |
| `agent-runtime/src/mcp-config.mjs` | `EA296ECC1AFE6F06DF1494430D5F51CB167A142744F7423F1C308193F95826EB` |
| `agent-runtime/src/mcp-adapter.mjs` | `10A8901777EFABABC04804971F1A8D733D77C75B4355D7CD861B84A65EC0162C` |
| `agent-runtime/src/runtime.mjs` | `B8F386C41B93C26AE48720E4BF975D720F490C4C1E79706E8EE174255EEDE0E9` |
| `agent-runtime/test/mcp-config.test.mjs` | `43DB8727DCC922F08F99B3F42950945A1B80E3BB70482B0D65756C1D5C4A2DDC` |
| `agent-runtime/test/mcp-adapter.test.mjs` | `A9B9218810456F14051B0C21E0C4029A2ED0F351492EE87B630EBD6234B33C39` |
| `agent-runtime/test/mcp-runtime.test.mjs` | `403F65A935DB75248FE630FD2AA541BECF95AFE23482717A3C29043E8DB6CD52` |
| `tests/island.test.tsx` | `B040DA7464A3C261FBDEC3264442EC637418D22000E951F3E51F787FE855A31F` |

## 5. 仍未验证的范围

本轮只补开发证据。真实宿主 / 原生焦点 / 80:20 布局与恢复、Acrylic / DWM / DPI、真实 provider 与第三方 MCP、真实 Word 打开和整套人工可读性仍未验证；完整人工和安装包继续按既有决定无限期延期。G01 同步加载 / 单次提取无普遍硬时间保证，LIMIT-01 和其余明确限制保留。

RT-01–11 完成不等于外部 agent feature 自动启动，也不能关闭 C6-I035 或把旧人工清单标为通过。下一项新开发仍需按主计划从具体用户任务确定范围。
