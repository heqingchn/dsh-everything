# dsh-everything

为 Windows 上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Everything 索引搜索：给**人**用的 `@文件` 补全，给**模型**用的 `find_files` 工具，以及设置页上的排除项配置卡片——三者共用同一份 [Everything](https://www.voidtools.com/) 索引，经官方 SDK 在进程内查询。

> 本包合并了 [`dsh-at-file-everything`](https://github.com/backkom/dsh-at-file-everything) 与 [`dsh-plugin-everything`](https://github.com/keyblues/dsh-plugin-everything) 的能力：保留前者的 `@` 补全与排序契约、配置卡片，后者的 SDK 桥与工具卡片，并统一走进程内 FFI，去掉 `es.exe` 子进程与它带来的一整套绕坑代码。

## 为什么合并

两个上游各解决一半问题，各自都带着对方没有的成本：

| | `dsh-at-file-everything` | `dsh-plugin-everything` | 本包 |
|---|---|---|---|
| 面向人 | `@` 补全（替换上游遍历方案） | 无 | 保留 |
| 面向模型 | `find_files` | `everything_search` / `everything_status` | `find_files` |
| 查询通道 | 每次 spawn 一个 `es.exe` | 进程内 N-API FFI | 进程内 N-API FFI |
| 配置卡片 | 有（排除列表 + `es.exe` 探测） | 无 | 有（排除列表 + 运行状态） |
| 工具结果卡片 | 无（回退通用行） | 有 | 有 |
| 绕开的外部行为 | 编码、CSV 列序、`-n` 版本差异、客户端版本钉死 | 无 | 无需绕开 |

合并的核心收益不是"功能更多"，而是**一条通道同时服务两个调用方**：`@` 补全每次按键都要查一次，`es.exe` 每次约 190 ms 的进程开销在这个频率上是持续成本；而 SDK 直接给出 UTF-16 路径与目录标识，`-export-csv`、`-utf8-bom`、表头定位、`Attributes` 位掩码、客户端版本表全部不再需要。

## 前置条件

- **Windows x64** 上运行 DeepSeek Harness。
- 本机已安装 [voidtools Everything](https://www.voidtools.com/) **并保持运行**（实测 1.4.1.1028）。索引在 Everything 进程内，插件通过 SDK 的 IPC 读取结果；没有运行就无法工作。
- **不需要** `es.exe`，**不需要** Everything Service，**不需要** HTTP/ETP 服务器。SDK DLL 与 FFI 模块随包分发。

## 安装

```powershell
# 开发阶段直接指向本仓库（安装是复制而非符号链接，改完要重装）
dsh plugin --profile <profile> add link:D:\code\CodeBase\github\dsh-everything
```

随包的 `cordis.patch.yml` 会插入 `file-reference-everything` 行，并**禁用** `file-reference-local`——Cordis 不允许一个作用域里有两个同名服务的提供者。因此本包必须排在挂载 `file-reference-local` 的 bundle（通常是 `@deepseek-ai/dsh-web-app`）之后；`dsh plugin add` 默认追加到末尾，满足这一点。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `find_files` | 按文件名或片段定位任意已索引磁盘上的文件/文件夹，返回绝对路径，支持 `path` 限定与 `limit` 分页 |
| `everything_search` | 用 Everything 查询语法检索：按扩展名、大小、日期、文件夹过滤，支持 AND / OR / NOT 与 `regex:` |

```json
{ "query": "playable", "path": "Y:\\pm-devs", "limit": 50 }
{ "query": "ext:ts size:>100kb dm:today", "sort": "date-modified", "descending": true }
```

**两个工具的分工由提示词说明，不靠模型猜**：

- `find_files`：知道名字、要最快，默认首选；
- `everything_search`：要按扩展名 / 大小 / 日期过滤，或需要布尔与正则；
- `glob`：工作区内按路径模式、要遵守忽略规则；
- `grep`：搜内容。

`everything_search` 常用语法：

```
ext:ts size:>100kb dm:today            今天改过的大 TypeScript 文件
file:*.log path:C:\work !temp          某目录下的日志，排除 temp
folder:node_modules dm:>2026-11-01     最近新建的依赖目录
regex:^v\d+\.\d+\.\d+                  按模式匹配版本号文件
```

- **只搜名字与元数据，不搜内容。** 内容是 `grep` 的事。
- **`path` 是可选的子树限定**；省略则搜所有已索引磁盘。
- **结果是分页的**：结果文本末行说明这一页与匹配集的关系。
- **`regex:` 可用但慢**：它不使用文件名索引，能扫全索引；`queryTimeoutMs` 会兜底，工具描述里也写明优先用 `ext:` / `size:` / `dm:`。
- **不需要配置提示词。** 注册工具时同时注入分工说明。

## 配置

设置 → 插件 → `dsh-everything`。卡片上有三组排除列表与一行 Everything 运行状态。

| 字段 | 默认 | 含义 |
|---|---|---|
| `excludeInQuery` | `[]` | 文件夹名/通配符，**在查询内**剪掉（连内容一起）。不占候选配额，但每次查询多几毫秒。 |
| `excludeFilePatterns` | `[]` | 文件名/通配符，同样在查询内剪掉，例如 `*.meta`。 |
| `excludedDirectories` | `[]` | 只在返回行里过滤。查询时免费，但被丢掉的行已经消耗了 `maxCandidates`。 |
| `maxResults` | `20` | `@` 单次返回的候选数。 |
| `maxCandidates` | `300` | 排序前向 Everything 请求的行数。 |
| `queryTimeoutMs` | `10000` | 单次 SDK 请求超时；超时会终止 worker，下次查询自动重建。 |
| `fuzzyFallback` | `true` | 连续子串无匹配时用子序列重试（`pbin` → `PlayButton`）。 |
| `autoStart` | `false` | 查询因 Everything 未运行失败时，是否启动 `everythingPath`。 |
| `everythingPath` | `C:\Program Files\Everything\Everything.exe` | 仅用于上面那次启动。 |
| `sdkPath` | 空 | 空表示用随包的 `native/Everything64.dll`。 |
| `installPrompt` | `true` | 是否安装 seam 约定的 `@path` 说明。 |

**排除项默认为空**：该排除什么取决于工程（Unity 要 `Library`/`Output`，Rust 要 `target`，monorepo 都不要），给默认值只会在前两种工程里悄悄藏掉真实源码。

**排除列表只作用于 `@` 补全与 `find_files`，不作用于 `everything_search`。** 后者的调用方自己写了表达式；插件再追加 `!path:` 会静默删掉它明确要的东西。模型需要排除时自己写 `!`。

两个查询内列表为什么分开：Everything 对文件夹排除（`!path:*\Lib*\*`）和文件排除（`!*.meta`）的解析方式不同，合成一个就得猜用户指的是哪种。

## 行为

- **裸查询**（`@Archive`）：搜整个工作目录。
- **目录查询**（`@Assets/Scripts/`）：只列该目录，每层一次便宜查询；最后一个 `/` 之后的片段作为检索词发给索引，因此子项数超过页大小的目录依然答得对。
- **严格限定在工作目录内**：裸查询带 `path:` 限定，目录下钻有 `isWithin` 守卫，`@../sibling/` 与绝对路径不会列出工作区外的内容。
- **隐藏项**：查询本身以 `.` 开头之前不出现。
- **Everything 未运行时的实际表现**：`@` 补全**完全为空**——连当前目录的子目录都不会列出，因为本插件是 `ctx.fileReferences` 的唯一提供者，没有文件系统遍历回退。日志里有一条写明原因的记录，但那不是界面上可见的提示。`find_files` 与 `everything_search` 则抛出指明原因、并建议改用 `glob` 的错误。
  - 缓解方式一：在配置里打开 `autoStart`，查询失败时会拉起 `everythingPath` 并重试一次。
  - 缓解方式二：需要纯工作区检索时改用内置的 `glob` / `grep`。
- **排序复刻上游分档**：全名精确 > 前缀 > 子串 > 目录段 > 子序列；同分时目录优先、路径短者优先。换插件不改变某个按键序列最终选中的文件。

## 实现要点

```
Agent tool call / @ keystroke
   │
   ▼
index.ts ── worker_threads ──▶ sdk-worker.cjs
（服务/工具/配置）              │  koffi (N-API FFI)
                               ▼
                     native/Everything64.dll（官方 SDK）
                               │  WM_COPYDATA IPC
                               ▼
                        Everything.exe 的 NTFS 索引
```

- **为什么在 worker 里**：`Everything_QueryW(true)` 等 IPC 回复没有超时，卡住会阻塞调用线程。查询放在 worker，设超时，超时后终止并从干净的 SDK 状态重建。
- **为什么必须显式设每一项**：SDK 的搜索词、排序、请求字段都是线程级状态，会在请求之间残留，所以每次查询都完整指定。
- **`parent:` 用于列目录**：它只匹配直接父目录，避免事后过滤被截断的一页而丢掉名字排在后面的子项。
- **`path:` 用于限定子树**：它是子串匹配（`path:C:\work` 也匹配 `C:\workspace`），所以每条结果渲染前还会按根目录复核一次。
- **`find_files` 不暴露 Everything 语法**：模型写文件名或片段即可；`ext:`/`dm:` 与作用域、排除列表的交互是另一个面。

## 性能

本机实测（Everything 1.4.1.1028 · 399 万索引项 · 作用域 `D:\code\CodeBase\github` · 片段 `package` · 每页 300 · 15 次取中位与 P95）：

| 通道 | p50 | p95 | min | max |
|---|---|---|---|---|
| SDK 桥（本包） | 70.0 ms | 77.3 ms | 63.9 ms | 77.3 ms |
| `es.exe`（`dsh-at-file-everything`） | 192.3 ms | 268.8 ms | 181.8 ms | 268.8 ms |

`node scripts/bench-query.mjs --iterations 20` 可复现。差距主要来自进程启动与 CSV 导出往返；纯索引查询本身约 70 ms。

### 并发

一个 worker 串行处理所有请求，所以第 N 个并发请求要等前面 N−1 个。`node scripts/bench-concurrency.mjs` 实测（同查询、每页 300）：

| 并发 | 总耗时 | 最慢请求 |
|---:|---:|---:|
| 1 | 68 ms | 68 ms |
| 2 | 143 ms | 143 ms |
| 4 | 274 ms | 274 ms |
| 8 | 559 ms | 559 ms |
| 16 | 1,123 ms | 1,123 ms |

排队是线性的，但 16 层并发的最慢请求仍远低于 `queryTimeoutMs` 的默认 10 s；3 个 agent 各跑 3 次查询的真实并发验证中，9 次全部成功、结果一致。真实会话里工具调用之间隔着模型推理，实际队列深度通常只有 1–2 层。

## 上下文占用

每次请求固定占用：

| 项目 | 字符数 | 估算 token |
|---|---:|---:|
| 系统提示词（两段拼接） | 888 | ~222 |
| 两个工具定义 | 1,672 | ~418 |
| 合计 | 2,560 | ~640 |

`node scripts/measure-prompt.mjs` 可复测；估算按英文约 4 字符/token。

## 验证

```powershell
npm run typecheck        # 对 src/ 做严格 TS 检查
npm run build            # esbuild → lib/
npm run test             # 164 个测试：排序契约、查询语法、配置句柄、两个工具的契约、卡片渲染、包形状、真实 SDK
npm run verify:activate  # 按宿主方式 import + apply 一次
npm run probe            # 不装 Harness 直接问 SDK：可用性、parent:、path:
npm run bench            # 上面那张表
node scripts/measure-prompt.mjs   # 统计提示词与工具定义占用的 token
```

`test/` 不依赖 Harness 安装：纯逻辑在 `lib/pure.js`，配置校验在 `lib/config.js`，工具定义在 `lib/tool.js`（用 `dsh-tools` 桩驱动），浏览器半在 `lib/client.cjs.js`（用 React 桩展开）。`test/live.test.js` 需要 Everything 在运行，否则自动跳过。

## 已知限制

- **仅 Windows x64**，且效果取决于 Everything 的索引范围；未被索引的文件同样搜不到。
- **必须让 Everything 保持运行。** 它没有提供"启动服务"的能力，`autoStart` 只是启动客户端程序。Everything 关闭期间 `@` 补全完全不可用（不是降级为慢速遍历，而是直接为空），这是替换上游 `file-reference-local` 的代价。
- **没有遍历回退。** 上游 provider 在工作区里自己走文件系统，Everything 关闭时仍能列目录；本插件没有保留这条路径，以保证只有一套查询语义。需要时可用 `autoStart` 或内置 `glob`/`grep` 兜底。
- **检索限定在文件名。** 裸查询不匹配"只在深层路径里出现"的片段；目录查询按层列出。
- **查询无法中途取消。** SDK 调用在 worker 里跑，取消只在发起前检查——这与上游 `es.exe` 能 kill 子进程的做法有真实差距。
- **`find_files` 单次最多 500 条。**
- **Everything 索引冷态**时首次查询可能需要约 1 秒让服务换入索引。
- **`sdkPath` 改动需要重新加载插件**：桥在构造时绑定 DLL。

## 许可

MIT，见 [LICENSE](LICENSE)。随包分发 Everything SDK（MIT，voidtools / David Carpenter）、koffi（MIT，Niels Martignène）与 Everything 图标（MIT，voidtools）；完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

排序分档与查询语义来自 `dsh-at-file-everything`（MIT，leaf），SDK 桥与工具卡片思路来自 `dsh-plugin-everything`（MIT，keyblues）。

合并前后的对比、实测数据、发现的问题与未验证的缺口见 [docs/EVALUATION.zh.md](docs/EVALUATION.zh.md)。
