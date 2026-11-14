# 侧边栏选项卡是怎么做出来的 —— dsh-context 实现解析与复刻

解析对象：本机已安装的 `dsh-context@0.84.1`（profile 插件）与其所依赖的 DSH `0.2.2-rc.3` 前端包。
结论均来自源码与运行时探测，不是推测。

---

## 1. 结论：一行导航 = 两个 slot 的配对

DSH 左侧栏的「插件 / 自动化任务 / 上下文洞察」这些行不是硬编码的，而是两个 slot 用**同一个 id** 配对出来的：

| slot | 种类 / scope | 登记项 | 作用 |
| --- | --- | --- | --- |
| `sidebar.panellist` | list / root | `id`（必填）、`order`、`label` | 侧栏里的一行（图标 + 文字 + 选中态由宿主绘制） |
| `main` | keyed / root | `key`（必填，等于上面的 `id`） | 点开这一行后，中栏主面板渲染的内容 |

列表型 slot 的目录说明原文：

> Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata.

`main` 的目录说明：

> Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; other keys receive no Session binding.

所以「加一个侧边栏选项卡」的最小实现就是两次 `ctx.slots.register`，不涉及路由、不涉及改宿主代码。

## 2. 证据

**dsh-context 的 client 产物**（`node_modules/dsh-context/lib/client.js`）：

```js
function yd(e, t, n, r, i) {   // e = ctx, n = 页面组件, r = t()
  return _d(t.store, () => t.insightsEntry() === `show`, () => [
    e.slots.inject(`main`, () => e.slots.register(
      { name: `main`, key: vd, locale: i }, n)),
    e.slots.inject(`sidebar.panellist`, () => e.slots.register(
      { name: `sidebar.panellist`, id: vd, order: 20, label: () => r(`ov.title`), locale: i },
      e => React.createElement(Icon, { size: e.size }))),
  ])
}
```

`vd = 'dsh-context'`，`ov.title` 在中文词典里是 `上下文洞察`。可见：

- 侧栏行的组件**只是图标**（拿到 `size` 就用），文字由 `label` 元数据投影；
- 页面组件注册在 `main` 上，key 与侧栏 id 相同；
- 两次注册都包在 `slots.inject(...)` 里，属于「宿主声明存在时才生效」的效果。

**运行时探测**（`cordis_inspect_query` → client `Slots.listSubTree`，`root: "sidebar.panellist"`）：

```
occupants: plugins(order 0, by WC), schedules(order 10, by WC), dsh-context(order 20, by dsh-context)
catalog.registration: id(string, required), order(number), label(string | (() => string))
ownerProps: { size: number, active: boolean }
```

**宿主源码**（`@deepseek-ai/dsh-client-ui-sidebar`）：

- `src/client/SidebarRoot.tsx` 的 `PanelRow`；
- `src/client/PanelIcon.tsx`：`renderSlot('sidebar.panellist', { size, active }, { only: id })`；
- `src/client/contract/slots.ts`：`SidebarPanelIconOwnerProps { size; active }`、`SidebarPanelMetadata { id; order; label }`。

## 3. 宿主怎么画这一行

`PanelRow`（简化）：

```tsx
<div className={clsx(css.panelEntry, wide && css.panelEntryWide, active && css.panelEntryActive)}>
  <Tooltip label={label} delayMs={500} disabled={wide}>
    <button className={css.panelRow} aria-label={label} aria-current={active ? 'page' : undefined}
            onClick={() => selectPanel(id)}>
      <span className={css.panelGlyph} aria-hidden="true">
        {renderFactorySlot('sidebar.panel.icon', { id, size: wide ? 16 : 18, active })}
      </span>
      {wide && <span className={css.panelTitle}>{label}</span>}
    </button>
  </Tooltip>
  {/* wide 时右侧还有「取消固定」按钮 */}
</div>
```

要点：

1. **点击**只做一件事：`selectPanel(id)` → layout store 的 `activePanelId` → `AppFrame` 的中栏执行
   `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })`。没有 URL、没有额外事件。
2. **`size` 是 16（展开显示文字）或 18（收起成图标栏）**，`active` 表示当前是否选中。
3. **颜色不由你决定**：行按钮 `color: var(--dsw-alias-label-primary)`，选中/悬停背景
   `var(--dsw-alias-interactive-bg-hover)`。所以图标必须用 `currentColor` 描边，不能写死颜色，
   否则深浅色主题和选中态都会错。
4. **文字、tooltip、aria、选中背景、溢出省略**全部由宿主负责，插件只提供图标 + `label`。
5. **排序**：`order` 升序，`plugins`(0) < `schedules`(10) < `dsh-context`(20)，占位相同则按注册顺序。
6. **「更多」菜单与固定**：`sidebar.panellist.actions` 声明后，侧栏出现「更多」入口，可把面板取消固定
   （pin 状态是内存态，`plugins` 特殊，永远显示且不在自定义列表里）。默认是固定显示的，所以新插件
   的行直接可见，无需额外登记。
7. 收起态（rail）下 `label` 变成 Tooltip 文案，图标尺寸换成 18。

## 4. label、locale 与刷新

- `label` 允许是 `string | (() => string)`。侧栏订阅 `slots` 与 `locale` 的变化重建行元数据
  （`syncPanels` + `ctx.slots.subscribe('sidebar.panellist', ...)` + `ctx.locale.subscribe(...)`），
  因此 thunk 会在**每次投影时**重新读取，语言切换不需要重新注册。
- 组件 props 里的 `t` 由 `register` 的 `locale: '<namespace>'` 合成；词典通过
  `ctx.locale.register(ns, localeId, dict)` 注册，`ctx.locale.bind(ns)` 拿到读取时解析当前语言的翻译函数。
- 注册都是「效果」（`ctx.effect` / `slots.inject`），插件卸载、禁用、slot 声明塌缩时自动撤销：
  侧栏行、页面、样式要一起来一起走。

## 5. dsh-context 额外做了、这次**没有**复刻的东西

这些是「上下文洞察」这个具体功能的加法，不是侧栏选项卡的必需项：

- **位置配置**：`placement: tab | sidebar | all | hide`，同一个页面还能作为会话内标签页
  （`conversation.view`，`id: 'context'`）出现；
- **条件注册**：`_d(store, () => store.insightsEntry() === 'show', ...)`，关闭设置项时侧栏行与页面
  一起消失（本质是同一组注册挂在 store 条件上）；
- **去重**：`ctx.slots.entries(id)` 检查已有登记，避免 HMR 重复注册；
- **其它入口**：右侧栏 `sidebar.right.pane.tab`、插件页卡片 `plugins.bundle.config`、
  输入框浮层 `conversation.input.overlay`；
- **样式**：产物里以 `<style data-plugin-css="dsh-context/base.css">` 注入 Tailwind 4 + 自定义 CSS。

## 6. 本项目怎么复刻

| 文件 | 作用 |
| --- | --- |
| `client.js` | 全部 UI。`apply(ctx)` 里注册词典、样式、`sidebar.panellist` 行、`main` 页面 |
| `index.js` | Host 半。现在为空（`export function apply() {}`），将来放 `harness.handle` 数据接口 |
| `cordis.patch.yml` | 把包插入 profile 的 Loader 行（`id: session-manager`） |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（`platform: web`、`immediately`、`inject`） |
| `locale/*.json` | 插件管理页/设置页显示的标题与描述 |
| `icon.svg` | 插件列表里的图标（36×36） |

关键代码就是 `client.js` 里的两次注册，与 dsh-context 同构：

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'session-manager', order: 30,
  label: () => t('tab.title'), locale: 'session-manager',
}, Icon))

ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'session-manager', locale: 'session-manager',
}, Panel))
```

与 dsh-context 的差异：

- `id` 用 `session-manager`，`order` 用 30，排在「上下文洞察」(20) 之后、「更多」之前；
- 不做位置配置、不注册会话内标签页，只做全局侧栏面板；
- 页面组件目前返回空容器（面板内容后续设计），只保留必要的容器样式。

## 7. 后续做面板内容时的接口

`main` 的 occupant 除了自己 `inject` 的东西，还会收到一套标准 props（实测目录）：

`useRemoteAccess`、`useResource`、`useContextMenu`、`useWorkspaces`、`usePanelInfo`、`useSessions`、
`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess`、`useWorkspaceAccess`。

- 会话列表/工作区列表这类客户端已有数据，直接走这些选择器钩子，不要自己订阅会话事件重扫；
- 浏览器读不到的数据（会话日志、token 统计、projection 派生值）放在 Host 半，用
  `harness.handle('<method>', fn)` 暴露、`host.call('<method>', args)` 调用；
- 样式只用 `--dsw-alias-*` 主题 token（`bg-base`、`bg-layer-1/-2`、`border-l1/-l2`、`label-primary/secondary`、
  `brand-primary`、`state-*`），不要写死颜色，否则深浅色主题不跟随；
- 不要 `require` 其它 Harness Client 包（包括 `dsh-client-ui-primitives`），自己写控件、复制交互模式。
