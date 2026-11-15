/**
 * Offline smoke test for the 会话管理 page.
 *
 * There is no browser in this session, so this harness evaluates the bundle the
 * same way the module loader would, applies the plugin to a fake client context,
 * renders the page component with the real standard-prop shapes, and walks the
 * returned element tree. It catches what syntax checks cannot: missing dictionary
 * keys, wrong prop names, and anything that throws during render.
 *
 * Run: node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/* ── minimal React stand-in (createElement + the hooks this page uses) ── */
let currentHooks = []
let hookIndex = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat().filter(child => child !== null && child !== undefined && child !== false) }
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef(value) { return { current: value } },
  useState(initial) {
    const index = hookIndex++
    if (!(index in currentHooks)) currentHooks[index] = typeof initial === 'function' ? initial() : initial
    return [currentHooks[index], next => { currentHooks[index] = typeof next === 'function' ? next(currentHooks[index]) : next }]
  },
  useEffect() { /* effects are inert in the harness */ },
}

/* ── element-tree helpers ── */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { visit({ text: String(node) }); return }
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit({ node })
  // Expand function components the way React would, with their own hook slots.
  if (typeof node.type === 'function') {
    const savedHooks = currentHooks
    const savedIndex = hookIndex
    currentHooks = []
    hookIndex = 0
    let rendered
    try {
      rendered = node.type(node.props)
    } finally {
      currentHooks = savedHooks
      hookIndex = savedIndex
    }
    walk(rendered, visit)
    return
  }
  for (const child of node.children || []) walk(child, visit)
}

function collectText(node) {
  const parts = []
  walk(node, ({ text }) => { if (text !== undefined) parts.push(text) })
  return parts
}

/* ── load the bundle like the web shell does ── */
let plugin = null
const store = new Map()
globalThis.window = {
  __ModuleLoader__: { load(entry) { plugin = entry.factory(require) } },
  localStorage: {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  },
  setTimeout: () => 1,
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
}
globalThis.document = undefined
const require = name => {
  if (name === 'react') return React
  throw new Error('unexpected module request: ' + name)
}
new Function('window', 'require', source)(globalThis.window, require)

if (plugin === null) throw new Error('bundle did not register a factory')

/* ── fake locale service, recording dictionaries ── */
const registered = new Map()
const dictOf = new Map()
const locale = {
  register(ns, localeId, dict) {
    const key = ns + '\u0000' + localeId
    if (registered.has(key)) throw new Error('duplicate dictionary ' + key)
    registered.set(key, true)
    dictOf.set(localeId, dict)
    return () => {}
  },
  bind(ns) {
    return (key) => {
      const dict = dictOf.get('zh') || {}
      const text = dict[key]
      if (text === undefined) missing.add(key)
      return text === undefined ? key : text
    }
  },
}
const missing = new Set()

/* ── fake slots service, recording registrations ── */
const registrations = []
const slots = {
  inject(key, callback) { callback(); return () => {} },
  register(options, component) { registrations.push({ options, component }); return () => {} },
}

const effects = []
/** The client Session service: the list the sidebar and this page share. */
let listRefreshes = 0
const sessionList = {
  refresh() { listRefreshes += 1; return Promise.resolve() },
}
const ctx = {
  effect(callback, label) { const dispose = callback(); effects.push({ label, dispose }); return () => {} },
  get(name) {
    if (name === 'locale') return locale
    if (name === 'sessions') return sessionList
    return undefined
  },
  locale,
  slots,
}

plugin.apply(ctx)

/* ── assertions: declared dependencies ──
   A service read without a matching `inject` entry makes Cordis throw
   "cannot get property … without inject" at click time, so pin the list here. */
const declared = new Set(Array.isArray(plugin.inject) ? plugin.inject : [])
for (const required of ['slots', 'locale', 'workspaces', 'uiWorkspace', 'sessions']) {
  if (!declared.has(required)) throw new Error('inject is missing a service the page reads: ' + required)
}
console.log('✓ inject: ' + Array.from(declared).join(', '))

/* ── assertions: registrations ── */
const bySlot = name => registrations.filter(entry => entry.options.name === name)
const panellist = bySlot('sidebar.panellist')
const main = bySlot('main')
if (panellist.length !== 1) throw new Error('expected one sidebar.panellist registration, got ' + panellist.length)
if (main.length !== 1) throw new Error('expected one main registration, got ' + main.length)
if (panellist[0].options.id !== main[0].options.key) throw new Error('row id and main key must match')
console.log('✓ slots: sidebar.panellist(id=' + panellist[0].options.id + ') + main(key=' + main[0].options.key + ')')
if (typeof panellist[0].options.label() !== 'string') throw new Error('label thunk must return a string')

/* ── fake session + workspace snapshots (shapes copied from the host contracts) ── */
const now = Date.now()
const makeSession = (id, title, cwd, updatedAt, extra = {}) => ({
  id, title, displayTitle: title, cwd, updatedAt, running: false, blank: false,
  retainedBy: { referenceCount: 0 }, ...extra,
})
const sessions = {
  ids: ['session-aaaaaaaa-1', 'session-bbbbbbbb-2', 'session-cccccccc-3', 'session-dddddddd-4'],
  byId: {
    'session-aaaaaaaa-1': makeSession('session-aaaaaaaa-1', '把默认工作区迁到 D 盘', 'D:\\AI\\DeepSeek Harness', now - 3 * 86400000),
    'session-bbbbbbbb-2': makeSession('session-bbbbbbbb-2', 'EarTrumpet 自启与居中位置调整', 'D:\\AI\\BetterEarTrumpt', now - 3600000, { running: true }),
    'session-cccccccc-3': makeSession('session-cccccccc-3', '会话管理页面布局与可行性评估', 'D:\\AI\\DSH-plugin\\dsh-session-manager', now - 60000),
    'session-dddddddd-4': makeSession('session-dddddddd-4', '没有归属的孤儿会话', undefined, now - 8 * 86400000),
  },
  phase: 'ready',
  projectionsBySession: {},
}
const workspaces = {
  items: [
    { workspaceId: 'w-1', path: 'D:\\AI\\DeepSeek Harness', title: 'DeepSeek Harness', sessionIds: ['session-aaaaaaaa-1'], createdAt: '', updatedAt: '' },
    { workspaceId: 'w-2', path: 'D:\\AI\\BetterEarTrumpt', title: 'BetterEarTrumpt', sessionIds: ['session-bbbbbbbb-2'], createdAt: '', updatedAt: '' },
    { workspaceId: 'w-3', path: 'D:\\AI\\DSH-plugin\\dsh-session-manager', title: 'dsh-session-manager', sessionIds: ['session-cccccccc-3'], createdAt: '', updatedAt: '' },
  ],
  archivedSessionIds: ['session-aaaaaaaa-1'],
  pinnedSessionIds: [],
  state: 'ready',
  phase: 'ready',
  error: null,
}

/* ── render the page once ── */
currentHooks = []
hookIndex = 0
const Page = main[0].component
const tree = Page({
  useSessions: selector => selector(sessions),
  useWorkspaces: selector => selector(workspaces),
  useSessionStatus: selector => selector(new Map()),
  usePanelInfo: selector => selector({ activePanelId: 'session-manager' }),
  t: undefined,
})

const texts = collectText(tree)
const joined = texts.join(' | ')
for (const expected of ['会话管理', '把默认工作区迁到 D 盘', 'EarTrumpet 自启与居中位置调整', '没有归属的孤儿会话', '未分类', '已归档', '运行中']) {
  if (!joined.includes(expected)) throw new Error('rendered output is missing: ' + expected)
}
console.log('✓ render: ' + texts.length + ' text nodes, expected labels present')

if (missing.size > 0) throw new Error('missing dictionary keys: ' + Array.from(missing).join(', '))
console.log('✓ dictionaries: every t() key resolves (' + registered.size + ' dictionaries registered)')

/* leak check: a raw placeholder or a raw key means an untranslated string got rendered */
const leaks = texts.filter(text => /\{[a-zA-Z]+\}/.test(text) || /^[a-z]+\.[a-zA-Z.]+$/.test(text))
if (leaks.length > 0) throw new Error('untranslated strings rendered: ' + JSON.stringify(leaks.slice(0, 5)))
console.log('✓ no placeholder or dictionary-key leakage')

/* the column config must drive both the header and the body: one checkbox cell
   plus one cell per visible column, all on the same grid template */
let grid = null
const rowCellCounts = []
walk(tree, ({ node }) => {
  if (node === undefined) return
  const style = node.props && node.props.style
  if (grid === null && style && typeof style.gridTemplateColumns === 'string') grid = style.gridTemplateColumns
  if (node.props && node.props.className === 'dsm-row') rowCellCounts.push((node.children || []).length)
})
if (grid === null || !grid.includes('minmax(82px, 1fr)') || grid.includes('minmax(0, 1fr)') || !grid.startsWith('22px 320px')) {
  throw new Error('grid template missing or wrong: ' + String(grid))
}
if (rowCellCounts.length === 0) throw new Error('no session rows rendered')
// 1 checkbox + 7 default columns: the flexible track is the 状态 column itself,
// not an empty gutter before 操作
for (const count of rowCellCounts) {
  if (count !== 8) throw new Error('expected 8 grid children per row (checkbox + 7 columns), got ' + count)
}
const trackCount = (grid.match(/minmax\([^)]*\)|[^\s]+/g) || []).length
if (trackCount !== 8) throw new Error('expected 8 grid tracks, got ' + trackCount + ' in ' + grid)
console.log('✓ columns: ' + rowCellCounts.length + ' rows × 8 cells, grid = ' + grid)

/* header affordances: the flex column ends at 操作 and 操作 ends at the pane
   edge, so neither may ship a resize handle that does nothing. The 操作 column
   is marked as a rail (tinted, no divider) and the flex column as the one that
   swallows the leftover width. */
let thCount = 0
let flexTh = null
let actionsTh = null
walk(tree, ({ node }) => {
  if (node === undefined) return
  const className = String((node.props && node.props.className) || '')
  if (/(^|\s)dsm-th(\s|$)/.test(className)) {
    thCount += 1
    if (/(^|\s)is-flex(\s|$)/.test(className)) flexTh = node
    if (/(^|\s)is-actions(\s|$)/.test(className)) actionsTh = node
  }
})
if (thCount !== 7) throw new Error('expected 7 header cells, got ' + thCount)
if (flexTh === null) throw new Error('no header cell is marked as the flex column')
if (actionsTh === null) throw new Error('no header cell is marked as the actions rail')
const hasResizer = node => (node.children || []).some(child => child !== null && child !== undefined && child.props && child.props.className === 'dsm-resizer')
if (hasResizer(flexTh)) throw new Error('the flex column must not ship a resize handle')
if (hasResizer(actionsTh)) throw new Error('the actions column must not ship a resize handle')
let resizers = 0
walk(tree, ({ node }) => { if (node !== undefined && node.props && node.props.className === 'dsm-resizer') resizers += 1 })
if (resizers !== 5) throw new Error('expected 5 resize handles (7 columns minus flex minus actions), got ' + resizers)
console.log('✓ header: 7 cells, flex + actions without handles, ' + resizers + ' draggable edges')

/* A column config written by an older build (or a corrupt one) must be clamped:
   a non-finite width would invalidate the whole grid-template declaration and
   stack every cell in one column — the failure this check exists for. */
store.set('dsh-session-manager:columns:v1', JSON.stringify([
  { id: 'session', width: 400, visible: true },
  { id: 'workspace', width: 120, visible: false },
]))
currentHooks = []
hookIndex = 0
const staleProps = {
  useSessions: selector => selector(sessions),
  useWorkspaces: selector => selector(workspaces),
  useSessionStatus: selector => selector(new Map()),
  usePanelInfo: selector => selector({ activePanelId: 'session-manager' }),
  t: undefined,
}
const staleTree = Page(staleProps)
let staleGrid = null
const staleCells = []
walk(staleTree, ({ node }) => {
  if (node === undefined) return
  const style = node.props && node.props.style
  if (staleGrid === null && style && typeof style.gridTemplateColumns === 'string') staleGrid = style.gridTemplateColumns
  if (node.props && node.props.className === 'dsm-row') staleCells.push((node.children || []).length)
})
if (/NaN/.test(String(staleGrid))) throw new Error('grid template contains NaN: ' + staleGrid)
if (!String(staleGrid).includes('400px')) throw new Error('stored width was ignored: ' + staleGrid)
// session kept, workspace hidden, actions forced visible: 6 columns + checkbox
for (const count of staleCells) {
  if (count !== 7) throw new Error('expected 7 cells with the workspace column hidden, got ' + count)
}
console.log('✓ columns: stale config clamped, hidden column dropped -> ' + staleGrid)
store.clear()

/* the page must survive an empty profile and a loading profile */
currentHooks = []
hookIndex = 0
const emptyTree = Page({
  useSessions: selector => selector({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }),
  useWorkspaces: selector => selector({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'loading', phase: 'pending', error: null }),
})
const emptyText = collectText(emptyTree).join(' | ')
if (!emptyText.includes('还没有任何会话')) throw new Error('empty state missing')
console.log('✓ empty state renders')

/* interaction contract: a row click toggles the check, a double click is inert
   (opening is the action button or Enter), the tree leaf is where double-click
   jumps to the conversation */
const rowNodes = []
walk(tree, ({ node }) => {
  if (node && node.props && /(^|\s)dsm-row(\s|$)/.test(String(node.props.className || ''))) rowNodes.push(node)
})
if (rowNodes.length === 0) throw new Error('no rows rendered')
for (const row of rowNodes) {
  if (typeof row.props['data-sid'] !== 'string') throw new Error('row is missing data-sid')
  if (typeof row.props.onClick !== 'function') throw new Error('row has no click handler')
  if (row.props.onDoubleClick !== undefined) {
    throw new Error('the list must not open on double-click; the open button is the only way')
  }
}
console.log('✓ rows: ' + rowNodes.length + ' rows, click toggles, double-click inert')

/* header centred, body left: no right-aligned body cell may remain */
let rightAligned = 0
walk(tree, ({ node }) => {
  if (node && /(^|\s)dsm-cell r(\s|$)/.test(String((node.props && node.props.className) || ''))) rightAligned += 1
})
if (rightAligned > 0) throw new Error('body cells are still right-aligned: ' + rightAligned)
console.log('✓ alignment: no right-aligned body cell; header and body both centre')

/* the sidebar menu items ship their own icon slot occupants */
const iconSlot = bySlot('contextMenu.icon')
const iconKeys = iconSlot.map(entry => entry.options.key).sort()
if (iconSlot.length !== 2 || iconKeys.join(',') !== 'dsh-session-manager.hide,dsh-session-manager.trash') {
  throw new Error('expected trash and hide icon occupants, got ' + JSON.stringify(iconKeys))
}
console.log('✓ menu icons: ' + iconKeys.length + ' contextMenu.icon occupants registered')

/* interaction contract: a row click toggles that row's check (so a second click
   clears it, ring included) and arrow keys move the cursor without touching the
   selection — walking the list must never fill the batch bar. */
currentHooks = []
hookIndex = 0
const liveProps = {
  useSessions: selector => selector(sessions),
  useWorkspaces: selector => selector(workspaces),
  useSessionStatus: selector => selector(new Map()),
  usePanelInfo: selector => selector({ activePanelId: 'session-manager' }),
  t: undefined,
}
const rowsOf = root => {
  const found = []
  walk(root, ({ node }) => {
    if (node === undefined) return
    if (/(^|\s)dsm-row(\s|$)/.test(String((node.props && node.props.className) || ''))) found.push(node)
  })
  return found
}
const countClass = (root, name) => rowsOf(root)
  .filter(row => new RegExp('(^|\\s)' + name + '(\\s|$)').test(String(row.props.className)))
  .length
const countNodes = (root, className) => {
  let total = 0
  walk(root, ({ node }) => {
    if (node !== undefined && node.props && node.props.className === className) total += 1
  })
  return total
}

let live = Page(liveProps)
if (countClass(live, 'is-checked') !== 0 || countClass(live, 'is-active') !== 0) {
  throw new Error('a fresh page must start with no check and no cursor')
}
rowsOf(live)[1].props.onClick()
hookIndex = 0
live = Page(liveProps)
if (countClass(live, 'is-checked') !== 1) throw new Error('a row click must check exactly one row, got ' + countClass(live, 'is-checked'))
if (countClass(live, 'is-active') !== 1) throw new Error('a row click must move the cursor ring with the check')
rowsOf(live)[1].props.onClick()
hookIndex = 0
live = Page(liveProps)
if (countClass(live, 'is-checked') !== 0) throw new Error('a second click on the same row must uncheck it')
if (countClass(live, 'is-active') !== 0) throw new Error('unchecking must take the cursor ring with it')
if (countNodes(live, 'dsm-batch') !== 0) throw new Error('the batch bar must disappear with the last check')
console.log('✓ interaction: row click toggles its own check, uncheck drops the ring')

const rowsBox = (() => {
  let found = null
  walk(live, ({ node }) => {
    if (found === null && node !== undefined && node.props && node.props.className === 'dsm-rows') found = node
  })
  return found
})()
if (rowsBox === null || typeof rowsBox.props.onKeyDown !== 'function') throw new Error('the list has no key handler')
rowsBox.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
hookIndex = 0
live = Page(liveProps)
if (countClass(live, 'is-checked') !== 0) throw new Error('an arrow key must not change the selection')
if (countClass(live, 'is-active') !== 1) throw new Error('an arrow key must move the cursor ring')
console.log('✓ interaction: arrows move the cursor only, selection untouched')

/* interaction contract: sortable headers, the time/size filters and the search
   hit highlight all live on the same rendered tree */
const sortButtons = () => {
  const found = []
  walk(live, ({ node }) => {
    if (node !== undefined && node.props && /(^|\s)dsm-th-sort(\s|$)/.test(String(node.props.className || ''))) found.push(node)
  })
  return found
}
const headers = sortButtons()
if (headers.length !== 4) throw new Error('expected 4 sortable headers (session/created/updated/size), got ' + headers.length)
headers[0].props.onClick()
hookIndex = 0
live = Page(liveProps)
if (sortButtons().filter(node => /(\s|^)is-on(\s|$)/.test(String(node.props.className))).length !== 1) {
  throw new Error('exactly one header must show the active sort')
}
const firstAsc = rowsOf(live)[0].props['data-sid']
if (countNodes(live, 'dsm-th-dir') !== 1) throw new Error('the active sort header must show its direction')
sortButtons()[0].props.onClick()
hookIndex = 0
live = Page(liveProps)
if (rowsOf(live)[0].props['data-sid'] === firstAsc) throw new Error('flipping the sort direction did not reorder the rows')
console.log('✓ sort: header click sorts, second click flips the direction')

const control = field => {
  let found = null
  walk(live, ({ node }) => {
    if (found === null && node !== undefined && node.props && node.props['data-field'] === field) found = node
  })
  if (found === null) throw new Error('no filter control for field ' + field)
  return found
}
const pick = (field, value) => {
  control(field).props.onChange({ target: { value } })
  hookIndex = 0
  live = Page(liveProps)
}
for (const field of ['range', 'size', 'sort']) control(field)
pick('range', '7d')
if (rowsOf(live).length !== 3) throw new Error('the 7-day window kept ' + rowsOf(live).length + ' rows instead of 3')
pick('size', 'small')
if (rowsOf(live).length !== 0) throw new Error('a size band must drop sessions whose size is still unknown')
if (!collectText(live).join(' | ').includes('没有匹配的会话')) throw new Error('the filtered empty state is missing')
pick('size', 'all')
pick('range', 'all')
if (rowsOf(live).length !== 4) throw new Error('clearing the filters did not restore every row')
console.log('✓ filters: time window and size band narrow the list, then clear')

let searchBox = null
walk(live, ({ node }) => {
  if (searchBox === null && node !== undefined && node.props && typeof node.props.placeholder === 'string' && node.props.placeholder.includes('搜索')) searchBox = node
})
if (searchBox === null) throw new Error('no search input rendered')
searchBox.props.onChange({ target: { value: 'Ear' } })
hookIndex = 0
live = Page(liveProps)
if (countNodes(live, 'dsm-mark') === 0) throw new Error('a search hit must render a highlighted run')
if (rowsOf(live).length !== 1) throw new Error('the search should have kept exactly one row, kept ' + rowsOf(live).length)
console.log('✓ search: ' + countNodes(live, 'dsm-mark') + ' highlighted hit(s), 1 matching row')

/* a width saved below a column's hard floor is lifted back to it, the page
   declares a colour scheme for native controls, and the column panel offers the
   name-length split */
store.set('dsh-session-manager:columns:v1', JSON.stringify([{ id: 'session', width: 60, visible: true }]))
currentHooks = []
hookIndex = 0
const squeezed = Page(liveProps)
let squeezedGrid = null
let scheme = null
let schemeAttr = null
walk(squeezed, ({ node }) => {
  if (node === undefined || node.props === undefined) return
  if (squeezedGrid === null && node.props.style && typeof node.props.style.gridTemplateColumns === 'string') {
    squeezedGrid = node.props.style.gridTemplateColumns
  }
  if (scheme === null && node.props.className === 'dsm-page') {
    scheme = node.props.style && node.props.style.colorScheme
    schemeAttr = node.props['data-scheme']
  }
})
if (!String(squeezedGrid).startsWith('22px 160px')) {
  throw new Error('a squeezed session width must be lifted to its 160px floor, got ' + squeezedGrid)
}
if (scheme !== 'dark' && scheme !== 'light') {
  throw new Error('the page must declare a colour scheme for native dropdowns, got ' + String(scheme))
}
if (schemeAttr !== scheme) throw new Error('data-scheme must follow the declared colour scheme')
if (!source.includes('[data-scheme="light"]')) throw new Error('no light-scheme stylesheet branch')
console.log('✓ columns: below-floor width lifted to 160px, colour scheme declared (' + scheme + ')')
store.clear()

let settingsButton = null
walk(squeezed, ({ node }) => {
  if (settingsButton !== null || node === undefined || node.props === undefined) return
  if (node.props.title === '列设置') settingsButton = node
})
if (settingsButton === null) throw new Error('no column settings button rendered')
settingsButton.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 100, bottom: 20 }) } })
hookIndex = 0
const panelTree = Page(liveProps)
let distributeButton = null
walk(panelTree, ({ node }) => {
  if (node !== undefined && node.props && node.props.className === 'dsm-cols-action') distributeButton = node
})
if (distributeButton === null || typeof distributeButton.props.onClick !== 'function') {
  throw new Error('the column panel is missing the name-length split button')
}
console.log('✓ columns: name-length split offered in the column panel')

/* ── the tree: clicking a workspace row folds it open, clicking again folds it
   shut, the caret is decoration, and the head carries one toggle instead of two
   buttons. Double-click on a leaf still jumps to the conversation. ── */
store.delete('dsh-session-manager:expanded-workspaces:v1')

const workspaceNodes = rendered => {
  const found = []
  walk(rendered, ({ node }) => {
    if (node === undefined || node.props === undefined) return
    if (!/(^|\s)dsm-node(\s|$)/.test(String(node.props.className || ''))) return
    if (typeof node.props['aria-expanded'] === 'boolean') found.push(node)
  })
  return found
}
const leafNodes = rendered => {
  const found = []
  walk(rendered, ({ node }) => {
    if (node === undefined || node.props === undefined) return
    if (/(^|\s)dsm-leaf(\s|$)/.test(String(node.props.className || ''))) found.push(node)
  })
  return found
}
const rowCount = rendered => {
  let count = 0
  walk(rendered, ({ node }) => {
    if (node !== undefined && node.props && /(^|\s)dsm-row(\s|$)/.test(String(node.props.className || ''))) count += 1
  })
  return count
}
/** The tree head must offer exactly one expand/collapse control. */
const headButtons = rendered => {
  let head = null
  walk(rendered, ({ node }) => {
    if (head === null && node !== undefined && node.props && node.props.className === 'dsm-tree-head') head = node
  })
  if (head === null) throw new Error('no tree head rendered')
  const stack = (head.children || []).find(child => child !== null && child !== undefined
    && child.props && child.props.className === 'sp')
  return stack === undefined ? [] : (stack.children || [])
}

currentHooks = []
hookIndex = 0
let treeLive = Page(liveProps)
if (workspaceNodes(treeLive).length === 0) throw new Error('no workspace node rendered')
if (workspaceNodes(treeLive).some(node => node.props['aria-expanded'])) {
  throw new Error('the tree must start folded when nothing was remembered')
}
if (leafNodes(treeLive).length !== 0) throw new Error('a folded tree must not render session leaves')
const rowsBefore = rowCount(treeLive)

const firstNode = workspaceNodes(treeLive)[0]
const caret = (firstNode.children || [])[0] || null
if (caret === null || !/(^|\s)dsm-caret(\s|$)/.test(String(caret.props.className || ''))) {
  throw new Error('a workspace row must still start with its caret')
}
if (typeof caret.props.onClick === 'function') {
  throw new Error('the caret must not be a second hit area — the row owns the toggle')
}

// click 1: opens this workspace and narrows the list to it
firstNode.props.onClick()
hookIndex = 0
treeLive = Page(liveProps)
const opened = workspaceNodes(treeLive).filter(node => node.props['aria-expanded'])
if (opened.length !== 1) throw new Error('clicking a workspace must open exactly that one, got ' + opened.length)
if (leafNodes(treeLive).length === 0) throw new Error('an open workspace must render its session leaves')
const rowsAfter = rowCount(treeLive)
if (rowsAfter >= rowsBefore) throw new Error('clicking a workspace must still narrow the list (' + rowsBefore + ' → ' + rowsAfter + ')')

// click 2: the same row folds shut again
workspaceNodes(treeLive)[0].props.onClick()
hookIndex = 0
treeLive = Page(liveProps)
if (workspaceNodes(treeLive).some(node => node.props['aria-expanded'])) {
  throw new Error('a second click on a workspace must fold it again')
}
if (leafNodes(treeLive).length !== 0) throw new Error('folding a workspace must drop its leaves')

// the head toggle: one button, label opposite to the tree's current state
let buttons = headButtons(treeLive)
if (buttons.length !== 1) throw new Error('the tree head must offer one expand/collapse button, got ' + buttons.length)
const labelOf = node => collectText(node).join('').trim()
if (labelOf(buttons[0]) !== '展开全部') throw new Error('a folded tree must offer 展开全部, got ' + labelOf(buttons[0]))
buttons[0].props.onClick()
hookIndex = 0
treeLive = Page(liveProps)
const allOpen = workspaceNodes(treeLive)
if (allOpen.length === 0 || allOpen.some(node => !node.props['aria-expanded'])) {
  throw new Error('the head toggle must open every workspace')
}
buttons = headButtons(treeLive)
if (labelOf(buttons[0]) !== '折叠全部') throw new Error('an open tree must offer 折叠全部, got ' + labelOf(buttons[0]))
const leaves = leafNodes(treeLive)
if (leaves.length === 0) throw new Error('expanding everything must render the leaves')
if (leaves.some(leaf => typeof leaf.props.onDoubleClick !== 'function')) {
  throw new Error('every tree leaf must open its session on double-click')
}
buttons[0].props.onClick()
hookIndex = 0
treeLive = Page(liveProps)
if (leafNodes(treeLive).length !== 0) throw new Error('the head toggle must close every workspace again')
console.log('✓ tree: row click folds both ways, one head toggle, double-click opens (' + leaves.length + ' leaves)')

/* ── deleting a session must also re-pull the shared Session list ──
   That store only changes on a Pull or on a Host frame, and a permanent delete
   removes files underneath the Host — so no frame ever arrives. Without the
   pull the row survives in the store and, because the workspace registry no
   longer claims it, the native sidebar re-renders it under 「未分组」: exactly
   the bug this check pins. */
const deleteRequests = []
globalThis.fetch = (url, options) => {
  const body = options && typeof options.body === 'string' ? JSON.parse(options.body) : {}
  deleteRequests.push({ url: String(url), body })
  const payload = String(url).endsWith('/delete')
    ? { ok: true, value: { deleted: body.ids || [], failed: [] } }
    : { ok: true, value: {} }
  return Promise.resolve({ ok: true, status: 200, json: async () => payload })
}

store.clear()
currentHooks = []
hookIndex = 0
let deleteTree = Page(liveProps)
const firstRow = (() => {
  let found = null
  walk(deleteTree, ({ node }) => {
    if (found !== null || node === undefined || node.props === undefined) return
    if (/(^|\s)dsm-row(\s|$)/.test(String(node.props.className || ''))) found = node
  })
  return found
})()
if (firstRow === null) throw new Error('no row to delete')
firstRow.props.onClick()
hookIndex = 0
deleteTree = Page(liveProps)

const pickFirst = predicate => {
  let found = null
  walk(deleteTree, ({ node }) => {
    if (found !== null || node === undefined || node.props === undefined) return
    if (predicate(node)) found = node
  })
  return found
}
const batchDelete = pickFirst(node => node.props.className === 'dsm-btn is-danger')
if (batchDelete === null) throw new Error('the batch bar offers no delete button')
batchDelete.props.onClick()
hookIndex = 0
deleteTree = Page(liveProps)

const ackBox = pickFirst(node => node.props.type === 'checkbox' && typeof node.props.onChange === 'function')
if (ackBox === null || ackBox.props.checked !== false) throw new Error('the delete dialog offers no unacked confirmation')
ackBox.props.onChange({ target: { checked: true } })
hookIndex = 0
deleteTree = Page(liveProps)

const refreshesBefore = listRefreshes
const confirmButton = pickFirst(node => node.props.className === 'dsm-btn is-solid-danger')
if (confirmButton === null) throw new Error('the delete dialog has no confirm button')
if (confirmButton.props.disabled !== false) throw new Error('the confirmed dialog must enable its confirm button')
await confirmButton.props.onClick()

if (deleteRequests.filter(entry => entry.url.endsWith('/delete')).length !== 1) {
  throw new Error('the confirmation must post exactly one delete request')
}
if (deleteRequests[0].body.ids.length !== 1) throw new Error('the delete request must carry the checked row')
if (listRefreshes !== refreshesBefore + 1) {
  throw new Error('a permanent delete must re-pull the Session list (refreshes ' + refreshesBefore + ' → ' + listRefreshes + ')')
}
console.log('✓ delete: one request, then the shared Session list is re-pulled')

console.log('\nsmoke: OK')
