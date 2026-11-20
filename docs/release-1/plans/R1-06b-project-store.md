# R1-06b：项目存储底座

日期：2026-11-20。里程碑 2 / M11；对应验收 F15–F24 的存储与引用部分。状态：**plan 已写，未开始实现**。当前 WIP 只在 [RECOVERY-PLAN](../../RECOVERY-PLAN.md#2026-11-09-release-1-当前执行表)维护。

## 1. 用户结果与停止线

这一项**不改变用户看到的东西**：它是项目层的存取底座，把"项目目录承载会话"从决策变成可用的代码与测试。真正接线（会话列表按项目、整理命令、按需读取）在 06c。

停止线：项目根、inbox、元数据、README、会话子目录、读取接口、移动原语与开关全部成立并有自动回归；受保护路径生效；损坏的元数据被诊断而不是让整个项目层不可用。本任务不迁移旧会话，不接 UI。

## 2. 已核对的现状与根因

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 没有项目实体 | 全仓无 `project` 存储 | 需要新建 |
| 会话库是单一平铺目录 | `resolveSessionRoot` → `%LOCALAPPDATA%\Aside\sessions` | 两层结构没有落点 |
| 会话 header 的 `cwd` 是常量 `aside-session` | `session.mjs` 的 `ASIDE_SESSION_CWD_NAME` | **移动会话可以只 rename**，不改内容；方案成立的前提 |
| JSONL 文件名含时间戳与 id | Pi `JsonlSessionRepo` | 移动不需要重命名 |
| 已有受保护路径机制 | `config.mjs` 的 `protectedWorkspacePaths` | 项目根可直接加入 |
| 默认输出根是 `Documents/Aside` | 原生 `default_workspace` | 项目根放在它下面时**必须**受保护，否则普通文件工具能读整个会话库 |
| 设置字段是扁平字符串 | `settings-schema.mjs` 的 `SETTINGS_FIELDS` | 开关按同一形状加入，默认值在 `publicValues` 补齐 |

根因：项目层尚不存在；其余机制（会话仓库、受保护路径、设置来源）都可直接复用。

## 3. 输入 / 输出与契约

**布局**

```
<projectsRoot>/
  inbox/
    project.json
    README.md
    sessions/
      --aside-session--/
        <timestamp>_<id>.jsonl
```

- `<projectsRoot>` 默认 `join(ASIDE_DEFAULT_WORKSPACE_ROOT, "projects")`，可由 `ASIDE_PROJECTS_ROOT` 覆盖；必须是绝对路径，且加入 `protectedWorkspacePaths`。
- 项目 id 即目录名，slug 规则 `^[a-z0-9][a-z0-9-]{0,63}$`；`inbox` 为保留 id。
- 每个项目只用两个普通文件 + 一个会话目录，不建二级索引。

**`project.json`**

```json
{ "schemaVersion": 1, "name": "Inbox", "description": "Unfiled work", "directories": [] }
```

- `name` ≤ 120 字符；`description` 是**一句话**，≤ 240 字节；`directories` ≤ 8 项，每项绝对路径 ≤ 4096 字节、无控制字符。
- 目录引用是**资料引用，不是路径权限**；读取或路由仍需现有路径校验。
- 元数据损坏时：项目仍出现在列表里并带诊断，不静默消失；README 若能读仍可读。

**`README.md`**：普通 Markdown，读写上限 16 KiB；这是 agent 与用户共同阅读的项目说明，不是第二份会话记录。

**开关**：设置字段 `memory_enabled`（环境变量 `ASIDE_MEMORY_ENABLED`），默认 `"true"`。关闭时：读取接口返回"已关闭"，整理写入不可用；项目目录本身仍在磁盘上，不被删除或移动。

**读取接口**（供 06c 的 agent 读取；本任务只实现并测试，不接线）：

- `listProjects()` → `{ id, name, description, sessionCount, modifiedAt }[]`，按 `modifiedAt` 倒序
- `readProjectReadme(id)` → 有界文本
- 永不返回原始 JSONL；会话历史读取走 04a/06a 的投影接口（06c 接线）

**写原语**（供 06c 的整理命令；本任务不暴露为 agent 工具）：

- `createProject({ id, name, description })`
- `writeProjectReadme({ id, text })`
- `moveSession({ sessionId, from, to })`：原子 rename；源必须存在、目标不得有同 id；**内容字节不变**；失败保留原位
- `openProjectSessionStore(id)`：复用 `createAsideSessionStore`，`root = <project>/sessions`，`cwd` 保持 `aside-session`

**旧会话**：`%LOCALAPPDATA%\Aside\sessions` 原样保留、不列出、不迁移。开发阶段接受"升级后看不到旧会话"，但公开发布前必须另定处置；此条不得被当成永久产品决定。

## 4. 分步实施，串行完成

1. **路径与开关**：解析项目根、加入受保护路径、`memory_enabled` 默认值进入设置投影；项目根不可用时给出明确诊断而不是崩溃。
2. **inbox 与元数据**：首次访问创建 `inbox`；实现 `project.json` 读写、slug 与字段校验、上限。
3. **README**：读写与 16 KiB 上限；缺失时返回空并带诊断。
4. **读取接口**：`listProjects` / `readProjectReadme`；关闭开关时明确返回"已关闭"。
5. **移动原语**：原子 rename、冲突与缺失处理、内容不变校验。
6. **回归与证据**：布局、inbox、校验、损坏、上限、开关、受保护路径、移动原子性。

## 5. 失败语义

- 项目根不可用（无文档目录 / 路径非法）：项目层整体报"不可用"，不创建半成品目录，不影响会话基础功能。
- 元数据损坏：项目仍列出并带诊断；不自动覆盖、不删除。
- 目录引用失效或越界：报告失效，不自动跟随、不把它当成路径权限。
- 移动目标已存在 / 源不存在 / 跨盘 rename 失败：拒绝并保留原位置，不重写文件、不尝试复制后删除。
- 开关关闭：读取返回"已关闭"，写入原语拒绝；不删除已有项目。
- 项目根被普通文件工具访问：受保护路径拒绝，错误信息说明它属于 Aside 私有存储。
- 并发：创建 / 移动 / 写 README 加锁；锁冲突明确失败，不静默覆盖。

## 6. 自动完成条件

| 检查 | 必须证明 |
| --- | --- |
| 布局 | 首次访问创建 `inbox` 及完整布局；重复访问幂等 |
| 元数据 | 合法读写往返；非法 slug / 超长 / 控制字符被拒绝；损坏文件仍列出并带诊断 |
| README | 读写往返；超 16 KiB 被拒绝；缺失时返回空 |
| 读取接口 | 列表含名称与一句话描述；关闭开关时返回"已关闭"；永不返回原始 JSONL |
| 移动 | 会话移动后内容逐字节不变、位置正确；目标冲突与源缺失被拒绝；失败保留原位置 |
| 受保护 | 项目根不可被普通文件工具读写；错误信息不泄露内容 |
| 开关 | 默认 `true`；环境覆盖生效；关闭后读取与写入均不可用，但磁盘内容不变 |
| 兼容 | 未接线时应用行为与现在一致；旧平铺会话不受影响 |

从定向测试开始，再运行根 `typecheck`、`runtime:test`、`frontend:test`、`build`，以及 `cargo test --manifest-path src-tauri/Cargo.toml`。新测试进入正式脚本。

## 7. 不在本任务完成的验收

会话列表按项目、整理命令、归属判断、按需历史读取与目录路由归 06c；排除 / 纠错 / 关闭生命周期 / 固定用例成本归 06d；旧库迁移与发布处置、真实桌面与安装包归发布收口。任务结束时写清改动文件、门禁、未执行项、限制与对应 issue；不自动 commit / push，不开始 06c。
