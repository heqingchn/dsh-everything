# 合并评估：dsh-everything

这份文档回答一个问题：把 `dsh-at-file-everything` 与 `dsh-plugin-everything` 合并成一个插件，是否值得用。

测量环境：Windows x64、Everything 1.4.1.1028、399 万索引项、Node 24.13、DeepSeek Harness 0.2.3-alpha.2（源码 checkout）。

## 结论

**值得用，但有明确的适用边界。**

合并后的插件用一条进程内 SDK 通道同时服务 `@` 补全、`find_files` 工具和配置卡片，在真实索引上比 `es.exe` 路线快 **2.7×（p50）/ 3.5×（p95）**，同时删掉了整个 CSV / 编码 / 客户端版本适配层。代价是引入了一个原生模块（N-API，已验证 ABI 稳定）和一条"查询不可中途取消"的降级。

它不适合的场景：不想让 Everything 常驻的机器、非 Windows 环境、以及需要"按内容搜"的场合——这三条与两个上游一致。

## 能力覆盖

| 能力 | 合并前（两个插件） | 合并后 |
|---|---|---|
| `@` 补全 | 仅 at-file | ✅ 保留 |
| `find_files` | 仅 at-file | ✅ 保留 |
| Everything 语法工具 | 仅 plugin-everything | ✅ 保留（`everything_search`） |
| 工具结果卡片 | 仅 plugin-everything | ✅ 保留（一个组件服务两个工具） |
| 配置卡片 | 仅 at-file | ✅ 保留 |
| 运行状态只读 | plugin-everything（状态工具） | ✅ 并入配置卡 |
| 排除列表 | 仅 at-file | ✅ 保留（只作用于 `@` 与 `find_files`） |
| `autoStart` | 仅 plugin-everything | ✅ 保留，`@` 也受益 |

## 实测数据

### 延迟（同查询、同页大小、交替采样 15 次）

| 通道 | p50 | p95 |
|---|---|---|
| SDK 桥 | 70.0 ms | 77.3 ms |
| `es.exe` | 192.3 ms | 268.8 ms |

复现：`npm run bench`。

### 查询语义（真实索引验证）

`test/live.test.js` 在真实 Everything 上确认了三件此前只是假设的事：

- `parent:"<dir>"` 返回的每一行，其父目录确实等于 `<dir>`（12 项命中，逐条断言）。
- `path:"<dir>"` 返回的每一行都落在该子树内。
- 查一个不存在的名字返回空页而不是错误。

### 代码与配置面

| 指标 | 合并前合计 | 合并后 |
|---|---|---|
| 源码行数（含类型声明） | 4 723 | 4 228 |
| 配置字段 | 16 | 11 |
| 依赖的宿主服务 | fileReferences / tools / settings / webServer | 相同 |
| 运行时外部进程 | 每次查询一个 `es.exe` | 无 |
| 需要维护的适配层 | 2 套（CSV 与 FFI） | 1 套（FFI） |

行数不是主要论据——合并后的 `client.ts` 更大是因为两个卡片在一处。真正的缩减是**删掉了 `es.exe` 的整条适配链**（spawn、编码、CSV 解析、列序定位、位掩码、版本表、随包二进制）。

## 合并过程中发现的真实问题

这些问题在合并时暴露出来，对上游也有参考价值。

### 1. 随包 `es.exe` 1.1.0.34 在本机 `%TEMP%` 无法导出 CSV

`es.exe -export-csv <file>` 在 `C:\Users\<user>\AppData\Local\Temp\...` 下稳定返回退出码 5（"Failed to create output file"），在仓库目录下则正常。而 `dsh-at-file-everything` 的 `EsClient.query` 恰好用 `mkdtemp(tmpdir())` 建临时目录：

```ts
const directory = await mkdtemp(join(tmpdir(), 'dsh-at-file-everything-'))
```

**后果**：在这样一台机器上，只要它回退到随包副本（即 PATH 上没有 `es.exe`，正是随包副本存在的目的），每次查询都会失败，`@` 返回空列表。

**注意**：只在当前这一台机器上复现过，可能是本机安全策略而非 `es.exe` 的普遍行为。但"兜底副本只在最需要它的时候失效"这个组合值得上游验证。本包不再走这条路径，因此不受影响。

### 2. `dsh-at-file-everything` 的 `dsh.client.inject` 引用了一个不存在的包

```json
"dsh.client": { "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins", "@deepseek-ai/dsh-client-locale"] }
```

当前 DSH（0.2.3-alpha.2）`packages/client/` 下没有 `ui-settings-plugins`，对应能力在 `ui-plugin-manager`。该字段是 informational（不排序激活、不阻断加载），所以不会致命，但 preflight 与 HMR 图会引用一个不存在的依赖。本包改成了实际存在的两个包名，并由 `test/bundle.test.js` 断言。

### 3. Everything SDK **没有** `Everything_SetSearchPathW`

合并时的第一版假设 SDK 提供 `SetSearchPath`（`es.exe -path` 的底层形式），koffi 直接报 `Cannot find function`。真实情况是 SDK 只提供搜索词字符串，范围必须由查询语法表达。因此本包用 `path:"<dir>"` / `parent:"<dir>"`，并额外在渲染前复核每一行的归属。

这个错误本身有价值：它说明"两个上游的代码都正确"并不等于"它们组合起来正确"，合并会暴露单个仓库里都看不出的假设。

### 4. `dsh-plugin-everything` 的 `everythingPath` 默认值锚定安装位置

默认写死 `C:\Program Files\Everything\Everything.exe`，便携版或自定义目录的机器上 `autoStart` 会静默失效（错误只是"没启动"，不会说"路径不对"）。本包沿用该默认值（它是官方安装器的位置），但把路径列为可配置字段并在文档里点明。

## 验证记录

2026-11-23 在 `web` profile 上实际安装并验证：

| 项 | 结果 |
|---|---|
| 安装 | `link:` 安装为 junction（不是复制），`application: applied`，无 warning |
| 工具注册 | `find_files` 与 `everything_search` 均出现，分工提示词注入 |
| 配置卡片 | 设置 → 插件 → `dsh-everything` 渲染出排除列表与 Everything 状态行（截图确认） |
| 工具结果卡片 | `find_files` 与 `everything_search` 均渲染为自定义卡，尺寸/时间/截断提示正常（截图确认） |
| `@` 补全 | 替换 `file-reference-local` 成功，`node_modules` 等被忽略目录可见，延迟明显下降（用户实测） |
| 状态路由 | `/dsh-everything/api/status` 返回 401 而同前缀不存在路径返回 404，证明路由已注册 |
| 真实查询 | `ext:ts` + `sort:"date-modified"` + `descending`、`folder:node_modules` 全机 3003 命中，均正确 |
| 提示词有效性 | 盲测 subagent 复现"今天修改的 ts / eval 相关 / >100KB 日志"三个任务，三次全部走 `everything_search`，无一次 `recent` 误用、无一次 shell 替代检索 |

## 剩余缺口

仍未验证，不当作已完成：

1. **多 agent 并发。** SDK 桥是单 worker 串行化，多个 agent 同时 `@` 会排队；延迟上限是"排队深度 × 单次查询"，没有实测。
2. **Everything 未运行时的真实 UI 行为。** 错误路径在单元测试与卡片渲染里覆盖，但没有在真机上停掉 Everything 观察卡片与 `@` 的实际表现。
3. **`path:"A" \| path:"B"` 的多目录组合未触发。** 盲测任务都只涉及一个目录。
4. **浅色主题下的卡片视觉未单独确认。** 截图来自深色主题。

## 使用建议

- **该用**：Windows 上重度使用 `@` 找文件、工程里有体积巨大的生成目录（`Library/`、`Output/`、`node_modules/`）、希望模型直接按名字定位工作区外文件。
- **可用但不必**：已有 `es.exe` 路线且工作正常、对 190 ms 不敏感的场景——合并版的收益主要在按键延迟与维护面。
- **不该用**：Everything 不常驻、非 Windows、需要按内容搜索。

如果后续要扩展，最自然的方向是在 `everything_search` 上继续加深 Everything 语法已经覆盖的部分——例如把 `sort` 的六个值暴露给提示词示例、或让 `everything_search` 支持 `offset` 翻页。这些都不需要动 SDK 桥。
