# dsh-session-manager

给 DeepSeek Harness（DSH）左侧边栏加一个**会话管理**选项卡的插件。

## 现在是什么状态

- ✅ 左侧边栏「会话管理」选项卡（可选中、可收起成图标栏、可被「更多」菜单固定/取消固定）；
- ✅ 点开进入**布局 A**（工作区树 + 会话列表）的完整页面：
  - 工作区树：按 `workspace.json` 的注册顺序分组，可逐级折叠/展开、有「折叠全部 / 展开全部」，节点显示会话数与占用；「未分类」自动兜住不属于任何工作区的会话；
  - 会话列表：标题、工作区、创建、最后活动、大小、状态（正常/运行中/已归档），行内可打开 / 归档 / 取消归档；
  - 搜索（标题、工作区路径、会话 ID）、状态筛选（全部/正常/已归档）、排序（最后活动/创建/大小/标题）、「包含已隐藏工作区」；
  - 批量选择（行勾选、表头全选）与批量归档/取消归档，批量栏显示所选条数与占用；
  - 每会话**创建时间**与**磁盘占用**（`bytes` = 会话目录整棵树 + 该会话的 projection 缓存文档，两者也分开返回 `logBytes` / `cacheBytes`），由 Host 半的 `POST /api/dsh-session-manager/stats` 路由提供，页面按 `session.ids` 防抖请求，取不到时该列降级显示 `—`；
  - 右键工作区节点可隐藏/恢复，隐藏状态存在浏览器 `localStorage`（插件域内隐藏，不动 DSH 数据，见 [docs/FEASIBILITY.md](docs/FEASIBILITY.md) #13）；
  - 右键会话行有菜单：打开 / 更新标题（待接入）/ 归档 / 永久删除（待接入）。
- ⬜ **待接入**（通道已定案为 `connection.fetch.register`，见 [docs/FEASIBILITY.md](docs/FEASIBILITY.md) #11，下一步实现）：
  - 会话**永久删除**（按钮已按设计渲染，禁用并带说明 tooltip）：要删会话目录、projection 缓存、`workspace.json` 里的三处 id 与 `schedule.json` 引用，并处理运行中会话的写锁；
  - **更新标题**（单条/批量）：`ctx.sessionTitle.refresh(session)` 只对已挂载（live）的会话有效，需要分批 resume 并显示逐条进度；覆盖手动标题前的提示与「下次不再提示」也要在这一步落地。


## 开发脚本

`node scripts/smoke.mjs` —— 离线渲染冒烟测试：按模块加载器的方式求值 `client.js`，用假的 Client ctx 跑 `apply`，再用真实的标准 props 形状渲染页面，检查字典键是否齐全、是否有未翻译字符串泄漏、空状态是否成立。没有浏览器时这是唯一能提前发现渲染错误的办法。


## 安装

在 DSH 的 **插件** → **添加插件** 里选择本目录，或者用 `plugin_manager` 的 `install_bundle`
指向本目录绝对路径。安装后刷新页面，左侧边栏即可看到「会话管理」。

禁用/删除插件包会把这行、页面、注入的样式一起撤掉（所有注册都挂在插件 ctx 的 effect 上）。

## 实现要点

侧边栏选项卡不是路由，而是两个 slot 用同一个 id 配对：

| slot | 登记项 | 作用 |
| --- | --- | --- |
| `sidebar.panellist`（list） | `id`、`order`、`label` | 侧栏的一行；组件只画图标（`{ size, active }`），文字/选中态/tooltip 由宿主绘制 |
| `main`（keyed） | `key`（等于上面的 `id`） | 点击该行后中栏渲染的页面 |

完整的源码级解析（宿主怎么画这一行、`size` 为什么是 16/18、`currentColor` 为什么必须、
dsh-context 还多做了什么）见 [docs/SIDEBAR-TAB.md](docs/SIDEBAR-TAB.md)。

## 文件

| 文件 | 说明 |
| --- | --- |
| `client.js` | 全部 UI：词典、样式、侧栏行图标、空页面 |
| `index.js` | Host 半，暂空；将来放 `harness.handle` 数据接口 |
| `cordis.patch.yml` | 插入 Loader 行 `session-manager` |
| `package.json` | `dsh.bundle.patch` 与 `dsh.client`（`platform: web`、`immediately`、`inject`） |
| `locale/zh.json`、`locale/en.json` | 插件管理页显示的标题与描述 |
| `icon.svg` | 插件图标 |

## 接下来填内容时

- 行位置由 `client.js` 的 `PANEL_ORDER`（当前 30）决定：`plugins` 0 < `schedules` 10 <
  `dsh-context` 20 < 本插件 30；
- 页面组件能拿到标准 slot props（`useSessions`、`useWorkspaces`、`useSessionStatus`、`usePanelInfo` 等）；
- 浏览器读不到的数据放 Host 半，用 `harness.handle(method, fn)` + `host.call(method, args)`；
- 颜色只用 `--dsw-alias-*` 主题 token。

## 兼容性

面向 Web 端（`dsh.client.platform: web`），开发时对应 DSH 0.2.2-rc.3。
`client.js` 不是 ES module，而是 `window.__ModuleLoader__.load({ id, factory })` 形式的浏览器产物，
React 从宿主模块表 `require('react')` 取得，不额外安装。
