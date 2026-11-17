# dsh-daily-memory

给 DeepSeek Harness 的「每日复盘 + 长期记忆」插件。每晚回顾历史会话，把值得长期保留的信息提炼成本地 Markdown 记忆；需要时才检索，一次只取几条。

A daily reflection and long-term memory plugin for DeepSeek Harness. It reviews past sessions, distils durable notes into local Markdown, and retrieves only the few entries a question needs.

---

## 为什么这么做 / Why

两层设计，目的是让记忆**不占上下文**：

- **写入是离线的**：夜间运行在独立会话里，主会话零开销。
- **读取是按需的**：记忆永不自动加载；只有模型判断需要历史时，才调一次 `memory_search`，默认返回 3 条、最多 5 条、总量 ≤800 字。

把记忆塞进每次都要加载的提示文件，会让上下文随天数线性增长——这正是本插件要避免的。

---

## 安装 / Install

**方式一：插件管理器**

```bash
# 从 npm 或本地目录安装为 bundle
```

在 DSH 的 Plugin Manager 里 `install_bundle`，包名 `dsh-daily-memory`；或把本仓库目录作为本地 bundle 安装。装好后会激活 `daily-memory` 这一行，可用 `set_plugin` 停用。

**方式二：手动装进 profile**

1. 把仓库放到 `<profile>/plugins/dsh-daily-memory/`；
2. 在 `<profile>/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: daily-memory
      name: ./plugins/dsh-daily-memory/lib/index.js
      config: {}
```

3. 重启 DSH。

---

## 三个工具 / Tools

| 工具 | 作用 |
|---|---|
| `memory_review(mode, maxSessions)` | 读取待复盘会话并返回**裁剪后**的对话文本。`daily` 按游标窗口（上次成功运行至今），`backfill` 按队列回填历史，`probe` 只列清单。只读，不写记忆。 |
| `memory_commit(items, runMode, sessions, nextCursor)` | 写入记忆：自动查重、冲突时保留旧条并标 `superseded`、更新索引与主题文件、追加当日流水与运行日志。 |
| `memory_search(query, type, limit)` | 关键词检索，先过 `index.md`，命中再取原文块，只返回少量条目。 |

**分工原则**：插件负责采集、解压、查重、截断、原子写；**判断「值不值得记」交给模型**——这是判断力问题，不是规则问题。

## 提炼什么 / What gets stored

按优先级：已确认的决策与结论 > 用户偏好与明确要求 > 未完成事项与待办 > 关键事实与数据 > 已被否定的方案。
丢弃：闲聊、重复内容、过程性试错、工具输出的原始细节。

## 数据落在哪 / Storage

默认 `~/.dsh/memory/`（可用 `config.memoryDir` 改）：

```
index.md                     一行一条索引，唯一需要被检索的文件（≤300 行）
topics/{preferences,decisions,projects,todos,rejected}.md
daily/YYYY-MM-DD.md          当日流水，只追加，作为证据层
archive/                     淘汰条目，不删只移
state.json                   游标 / 回填队列 / 计数
_runlog.md                   每次运行一行
```

单条格式：

```
- [M-20261117-01] decision | 记忆目录定为 ~/.dsh/memory | 来源: 11-17 复盘方案 | 状态: active | 置信: 高
```

## 默认上限 / Default limits

| 项 | 默认 | 硬顶 |
|---|---|---|
| 单次写入条目 | 8 | 12 |
| 单条正文字数 | 120 | 200 |
| 检索返回条目 | 3 | 5 |
| 检索注入字数 | — | 800 |
| 单会话入模字数 | 30,000 | — |
| 开场自动加载 | 0 | 0 |

超出时：条目按优先级截断，正文截到上限并在末尾标 `…`；检索按相关度取前 N 条直到字数打满。

## 它读什么 / Privacy

- **读**：`~/.dsh/sessions/**/session.v4.jsonl.zstd`（本地会话记录，多帧 zstd + JSONL）。
- **写**：仅 `memoryDir` 目录下的 Markdown/JSON。
- 不联网、不上传、不调用任何外部服务。会话内容只在你本机的模型会话里出现。

## 配置 / Config

| 键 | 默认 |
|---|---|
| `memoryDir` | `~/.dsh/memory` |
| `sessionsRoot` | `~/.dsh/sessions` |

## 已知限制 / Known limitations

- 首次安装不会一次扫完全部历史：走 **backfill 队列**，每轮回填少量会话（建议每次 ≤8 个），几晚走完；队列清空后才转入日常窗口。
- 依赖 DSH 的会话文件格式（`session.v4.jsonl.zstd`）。格式变更需要更新 `lib/session-reader.mjs`。
- 定时不内建：用 DSH 自带计划任务每天 00:00 新开会话执行，插件本身不起进程。
- 检索是关键词匹配，不是语义检索；命中率靠条目用词质量。

## License

MIT
