# 会话管理 · 技术栈与可行性评估

评估基线：DSH 0.2.2-rc.3（Electron 打包版，源码在 `app.asar` 内），插件形态＝ profile bundle（Host 半 `index.js` + Client 半 `client.js` + `cordis.patch.yml`）。
下表的「已验证」都指读到了本机安装版的源码/类型/运行时契约，不是推测；不确定处直接标「需 spike」。

---

## 0. 三条通道（决定了每个模块怎么写）

| 通道 | 用途 | 已验证的依据 |
| --- | --- | --- |
| **Client 数据平面**：标准 slot props（`useSessions` / `useWorkspaces` / `useSessionStatus` / `usePanelInfo` / `useSessionAccess`…）+ 客户端服务（`ctx.workspaces` / `ctx.uiWorkspace` / `ctx.layout` / `ctx.contextMenus`） | 读列表、开会话、归档、注册右键菜单 | `SessionListState`/`SessionSummary`、`WorkspaceSnapshot`/`WorkspaceView` 类型已读到；`ctx.uiWorkspace.openSession(id)`、`ctx.workspaces.archiveSession(id,{stopActivity})`、`ctx.contextMenus.register({target:'session'|'workspace'})` 均已确认 |
| **Host 读取平面**：`ctx.sessionQuery.listSessions()`、`ctx.sessionPersistence.list()/stat()`、`ctx.workspaceRegistry`、以及**自建 session projection + `wire.view`** | 创建时间、磁盘大小、聚合统计 | `SessionRecord.header.createdAt`；`SessionPersistenceSnapshot.sizeBytes`（只是单个日志文件）；`workspaceRegistry` 全量方法已读到；dsh-context 就是靠自建 projection 把折叠结果送到前端的（其 `lib/index.d.ts` 里有 `declare module '@deepseek-ai/dsh-session-projection/types'`） |
| **Host 动作平面**：客户端没有 `harness`/`host`（那是动态 Cordis 插件专用）；bundle 要写宿主只能走 **Typert Remote**（`ctx.typertRegistry.register({ invocations })`，公开 API 存在，但描述符通常由 typert loader 从 `.d.ts` 生成）或 **commands**（`ctx.commands.register` + 客户端 `ctx.remote.commands.execute(sessionId, line)`，稳定但绑在会话上） | 真删除、批量改标题、隐藏工作区落盘 | 两者签名已读到；**bundle 能否自建 remote 命名空间尚未验证 → 这是唯一需要先做 spike 的架构问题** |

---

## 1. 功能模块 × 技术栈 × 可行性

| # | 模块 | 技术栈 | 数据 / 接口来源（已验证） | 可行性 | 主要风险 / 前置条件 |
| --- | --- | --- | --- | --- | --- |
| 1 | 侧栏选项卡（已完成） | Client slot `sidebar.panellist` + `main` | 上一轮已上线并验证 | **已交付** | — |
| 2 | 会话/工作区列表 + 实时更新 | `useSessions`（`SessionListState{ids,byId}`）、`useWorkspaces`（`items`、`archivedSessionIds`） | 都是 root 作用域选择器钩子，宿主内部就在用 | **高** | 全都是 client 内存态，刷新零成本；无 createdAt（见 #3） |
| 3 | 会话元数据补全：创建时间 / 磁盘占用 | Host 侧 `sessionPersistence.list()/stat()`（`header.createdAt`、`sizeBytes`）+ 自建 **session projection**（`summary: true`，`wire.view`）推到 Client | `sizeBytes` 只含一个日志文件；整目录（含历史代 `session.v1..v3.jsonl[.zstd]`）需自己 `fs` 递归求和；`storages/session_projcache/sessions/<id>.json` 单独算 | **高** | 需要 Host 半开工（当前是空壳）；扫描要给上限与缓存，否则上百会话会卡 |
| 4 | 工作区聚合（会话数 / 总大小 / 状态） | 由 #2 + #3 在 Client 端聚合；状态＝插件自有 hidden 表 + `archivedSessionIds` | `WorkspaceView{sessionIds}` 与 projection 值足够 | **高** | 总大小是逐会话大小求和，随 #3 一起刷新 |
| 5 | 树视图 + 折叠状态持久化 | 纯 React + 插件自有存储（`storageDomain` 或 `Config`） | `ctx.storageDomain.open({name, version, tables})`，`KvTable.put/delete`，写入是临时文件+fsync+rename 的原子替换 | **高** | 域名的 `name` 必须匹配 `^[a-z][a-z0-9_]*$` 且全局唯一；需 `zod` 依赖 |
| 6 | 搜索 / 筛选 / 排序 | Client 端内存过滤（标题、`cwd`、会话 ID 前缀） | 注意：本机 sqlite FTS 后端是 `path: ':memory:', openAt: never`，全文检索会返回 `SESSION_QUERY_SEARCH_DISABLED`；`sessionQuery` 的排序也是写死的 `createdAt desc` | **高（客户端过滤）** / 低（宿主全文） | 会话量大时需虚拟滚动（宿主基线模块表里有 `@tanstack/react-virtual`） |
| 7 | 批量归档 / 取消归档 | `ctx.workspaces.archiveSession(id,{stopActivity})` / `unarchiveSession(id)` | 已有客户端服务；运行中会话会被 `workspace/session-activity` 拦下并报 `workspace/session-active`，`stopActivity:true` 可先停再归档 | **高** | **没有 bulk 接口**，N 条要循环 N 次；需自己限并发（建议 3～4）与逐条结果 |
| 8 | 会话永久删除 | **必须自建**：Host 半删 ①`<sessions>/<slug>/<encoded-id>/` ②`storages/session_projcache/sessions/<id>.json` ③`workspace.json` 里 `archivedSessionIds`/`pinnedSessionIds`/各 `sessionIds` ④`schedule.json` 里 `target.sessionId` 引用 | 全仓库确认：**不存在任何 session 删除 API**（`dsh-session-persistence-jsonl/README.md` 原话：*"Nothing deletes session files … the seam has no deletion API"`）；反向可用 `ctx.sessionQuery` 定位、`Workspace.detachSession(id)`（Host 进程内）摘除归属 | **中** | ① 运行中会话持有写锁，必须先停（`workspace/session-stop` 或 agent cancel）再删；② 内存里的 projection-cache domain 不会自动失效，删完要么重启要么走 `ctx.storageDomain.get('session_projcache').table('sessions').delete(key)`；③ FTS 索引行下次观测时才自愈；④ 附件是内容寻址共享的，删会话不会释放空间（要在确认框里说明）；⑤ 必须先解决 #11 的调用通道 |
| 9 | 工作区隐藏（本页生效） | Client 过滤 + 插件自有 hidden 列表 | `useWorkspaces().items` 在页面里过滤是纯 UI 行为 | **高** | 见 #13 的限制说明 |
| 10 | 隐藏工作区的「复用」 | 创建时 DSH 自己按 `realpath` 去重：同路径 create 返回**既有**记录（标题不变、`sessionIds` 保留），所以隐藏态记录本来就在，恢复即可；被**删除**过的路径再创建会拿到**新 id** 且会话掉进 "Ungrouped"，需要 `Workspace.attachSession` 手工接回（要求 cwd 与记录 path 相等） | `workspaceRegistry.create` → `createCanonical` 去重逻辑；`workspaceRegistry.resolveByPath` | **高（隐藏后恢复）** / 中（删除后重挂） | 复用提示要判断「同路径已有记录」还是「只有孤儿会话」，两种文案不同 |
| 11 | Client → Host 动作通道（#8、#12 的前提） | **已定案：`connection.fetch.register`** —— 宿主半在 `ctx.connection` 上注册一条 `POST` 路由，浏览器半用同源 `fetch('api/…')` 调用，返回 `{ok,value}` / `{ok,error}` 信封 | 这是本机已安装第三方插件 **dsh-context** 的真实做法（其产物里 `connection.fetch.register({path:'/api/dsh-context/heads', methods:['POST'], requestBody:'buffered', fetch})`），第一方包 `dsh-session-log-export` 也用同一 API；`typert` 注册（`ctx.typert.register`）虽然存在，但描述符要手写 codec/schema，风险更高 | **高** | 路由受 `connection` 的鉴权门保护（实测未带凭据时统一 401，含不存在的路径），所以只有页面自己能调通；一条路由一个操作，需要自己封装信封与错误码 |
| 12 | 标题刷新（单条 / 批量） | Host：`ctx.sessionTitle.refresh(session, signal)`（或 `rename(session, title)` 写死标题）；会话必须 **live**（`ctx.sessions.get(id) === session`，否则抛 not live）；非 live 需 `ctx.agents.resume({resumeSessionId})` 先拉起 | `SessionTitleService.get/rename/refresh/register` 全签名已读到；官方「随对话更新的标题」= `session-title-all-prompts-llm` 提供 provider；**客户端没有任何 remote 动词**可触发刷新 | **中** | ① 只能刷新 live 会话，归档/久远会话要逐条 resume（内存与耗时成本，需分批+进度）；② 一次刷新＝一次 LLM 调用 + 一条 `session/title-llm-request` 日志事件，要提示成本；③ 同一会话并发刷新后者会 abort 前者；④ 无 provider 时只做确定性回退标题；⑤ 也依赖 #11 |
| 13 | 「隐藏」同步到 DSH 原生侧栏 | — | 工作区记录 `{path,title,sessionIds,createdAt,updatedAt}` **没有** hidden/visible 字段；`useWorkspaces` 是**唯一** root hook（`copyUnique` 会抛 duplicate）；宿主列表链 `workspaceRegistry.list()` → `workspace/follow` 不是 waterfall，插件不可过滤；原生侧栏 `sidebar.workspaces` 是 `single` 槽，只能**整体替换**（会连搜索、分组、弹窗、目录流程一起接管） | **低（原生侧栏）/ 不可行（不改 DSH）** | 诚实结论：本插件的「隐藏」是**插件域内的隐藏**（不删数据、不动 DSH 状态），只影响本页面；要让原生侧栏也隐藏，只能替换整个浏览区（`replaceRisk: shadows-shipped-ui`，宿主升级易碎）——**建议不做** |
| 14 | 侧栏会话菜单加「删除会话」 | `ctx.contextMenus.register({ target: 'session', id, order, resolve })`（数据驱动，支持 `danger`、`disabled`、`separatorBefore`、子菜单、`run()`） | 现有项与 order：`pin 100 / rename 200 / fork 300 / id 450 / open-in-app 500 / archive 600`；另有装饰槽 `sidebar.workspaces.session.menu.item` 与本插件无关 | **高** | 新项排 `700`，放在「归档会话」之后；`run()` 里复用与页面同一个函数 |
| 15 | 侧栏工作区菜单加「隐藏工作区」 | `ctx.contextMenus.register({ target: 'workspace', … })` | 现有项：`rename 100 / open-in-app 200 / delete 300` | **高** | 插在 `250`（删除工作区之前）；工作区菜单**没有** React 槽，只有数据驱动注册，正好够用 |
| 16 | 打开某个会话（从管理页跳回对话） | `ctx.uiWorkspace.openSession(sessionId)`；切回对话面板 `ctx.layout.selectPanel(null)` | 已在 `dsh-client-ui-schedule` / `-subagent` / `-chat` 中调用 | **高** | — |
| 17 | 权限门（只读访客 / Liveshare） | `useSessionAccess(id, endpoint)` / `useWorkspaceAccess(id, endpoint)`，endpoint 形如 `workspace/archiveSession`、`session/rename` | 端点全集在 liveshare `endpoint-classification.ts` 有断言覆盖 | **高** | 本机 owner 恒 true；危险动作按 endpoint 灰化并给 tooltip |
| 18 | 主题 / 无障碍 | 只用 `--dsw-alias-*` token；`role="tree"/"treeitem"`、`aria-live` 播报批量计数 | 上一轮已按真实 token 出稿 | **高** | 不要写死十六进制；`relativeTime()` 在基线模块表里但**无类型**，需自带语言串 |

---

## 2. 明确不可行 / 需要接受的限制

1. **原生侧栏无法按插件意图隐藏某个工作区**（#13）：除非整体替换 `sidebar.workspaces` 或改 DSH 源码。建议把「隐藏」定义为插件域内概念，并在 UI 文案里写明（设计稿已写）。
2. **没有会话删除 API**（#8）：必须自己删文件，接受「删完需重启/手动清 projection 缓存」这一代价，并做足二次确认。
3. **客户端拿不到会话创建时间与目录大小**（#2/#3）：必须在 Host 半自建 projection，等于本插件不能再是「纯前端插件」。
4. **全文检索被禁用**（#6）：本机 sqlite 后端是内存库、`openAt: never`，搜索只能前端过滤。
5. **批量都是 N 次单条 RPC**（#7）：没有 bulk 端点，批量只能循环 + 限并发 + 逐条结果。

## 3. 建议的落地顺序

| 阶段 | 内容 | 依赖 | 预估 |
| --- | --- | --- | --- |
| 0 | **通道 spike**：#11 最小验证（Host 注册 `ping`，Client 调通） | 无 | 0.5～1 天 |
| 1 | 只读页面：树 + 列表 + 搜索/筛选/排序 + 打开会话（数据全走 Client hooks） | 无（不依赖 #11） | 2～3 天 |
| 2 | Host 半：projection 补 createdAt/大小 + 工作区聚合 | 阶段 1 | 1～2 天 |
| 3 | 动作：归档/取消归档（已有 API）→ 隐藏工作区（插件域内）→ 永久删除（自建 + 确认流） | 阶段 0、2 | 3～4 天 |
| 4 | 侧栏菜单增量（#14/#15）与页面共用同一套动作函数 | 阶段 3 | 1 天 |
| 5 | 标题刷新（单条 → 批量，带进度与成本提示） | 阶段 0 | 1～2 天 |

## 4. 待你拍板

1. #11 的 spike 优先做哪条通道？（建议 Typert Remote，成功则删除/改标题都干净；失败退 commands）
2. 「隐藏工作区」接受「只在本插件内生效」吗？（要让原生侧栏也隐藏＝替换宿主浏览区，我不建议）
3. 永久删除是否需要「先归档、7 天后清理」的软路径？
4. 目录大小的口径：只算会话日志，还是加上 projection 缓存（数字会明显变大）？
5. 批量改标题默认是否覆盖用户手动改过的标题？
