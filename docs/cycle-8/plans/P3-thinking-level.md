# P3：思考强度

日期：2026-11-01。状态：开发与自动验证完成，留在工作区。依赖 P0 和 P1 模型能力入口。批次：C8.1。问题见 [ISSUES.md](../ISSUES.md)。

## 范围与用户结果

用户可为所选模型设置实际支持的思考强度，并核对当前任务采用的值。不增加温度、token budget 等全量高级参数。

## 计划

1. 核对当前 Pi 的 reasoning、thinkingLevelMap 与各现有 provider 的投影语义，形成有限支持列表。
2. 后端校验模型 / 档位组合，前端只呈现可用档位；切换模型时给出不兼容处理，不静默声称应用成功。
3. 用 P0 保存默认值，在下一任务或安全 runtime 重建时应用；当前 run 固定不变。
4. 在诊断中显示有效档位，用 faux provider 的实际出站请求验证每种保留映射。

## 验收边界

不支持推理的模型、provider 特有值和失效设置有明确状态；不把所有 provider 都映射为同一组档位。验证关注实际请求，不只断言 UI 选项或内部 state。

## 本批实现决策

- 可用档位只取模型自身元数据（Pi 的 `getSupportedThinkingLevels`），不维护第二份映射表。同一 provider 的不同模型档位不同：例如 DeepSeek `v4-pro` 只有 `off/high/max`，`v4-flash` 还有 `low`。
- 已保存档位在新模型上不可用时，用 Pi 现成的 `clampThinkingLevel` 回落到最近可用档，而不是直接落到 `off` 或拒绝该模型；界面同时显示“保存值”和“实际使用值”，并把调整作为可解释状态呈现。
- 解析结果分 `requested` / `applied` / `supported` / `adjusted` 四项，统一由 `thinking-level.mjs` 产生；runtime 与设置服务共用同一函数，避免两处推断分叉。
- Agent 初始化使用解析后的 `applied`；Pi 在 `off` 时不发出站 `reasoning` 字段，非 `off` 时直传该字段。`runtime_fields` 增加 `thinking_level`。
- 设置快照由服务端复用同一 provider 选择路径计算 `thinking`，模型不可解析时返回 `null` 而不是猜测档位。
- 界面只增加“思考强度”卡片，沿用现有宽度与圆角；未保存的档位同样阻塞“Apply when idle”，与其他未保存编辑一致。

## 验证记录

- 新增 12 项 runtime 回归：可用档位取自模型元数据（含同 provider 两模型差异）、有效档原样应用、相邻档回落、上下越界回落、无推理模型收敛到 `off`、未知 / 空值按 `off`、`off` 不出站 `reasoning`、配置值真正进入 Agent 状态、设置快照解析、保存往返、非法档位在读取时拒绝、模型不可解析时快照仍可加载。
- 实际出站断言使用 faux provider 的 `streamOptions.reasoning`，验证的是请求而非 UI 选项或内部 state。断言 `off` 时该字段为 `undefined`，因为 Pi 以省略字段表达关闭。
- 新增 5 项前端回归：只列出该模型支持的档位、无推理模型不显示选择器、保存后立即可见且阻塞应用、已保存但不可用的档位明确显示为“未被支持”、切换 provider 后档位集合收窄并提示回落。

## 保留限制与下一步

- 真实厂商是否接受投影出的 `reasoning` 参数仍未验证；本批只覆盖 faux provider 的实际请求与四家离线 catalog 元数据，不构成四家真实连通性验收。
- 只做档位选择，未增加温度、token budget 等高级参数，也未在诊断面板单独列出每个 provider 的映射细节。
- 思考内容（`thinking_start` / `thinking_delta`）未投影到会话界面；本批不改变聊天渲染。
- 下一个功能按 [P4](./P4-sessions.md) 实施会话管理；本批未开始 P4 / P5。
