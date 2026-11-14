/**
 * dsh-session-manager — Client half (browser bundle).
 *
 * Adds the 会话管理 entry to the left sidebar's global panel list plus the page
 * it opens (design: docs/UI-DESIGN.md, layout A — workspace tree + session list).
 *
 * HOW THE TAB WORKS (see docs/SIDEBAR-TAB.md)
 *   1. `sidebar.panellist` (list slot) — `id` is the row key, `label` its text.
 *      The component registered there is ONLY the row glyph.
 *   2. `main` (keyed slot) — `key` equals the same id; the host renders this
 *      entry into the center column when the panel is selected.
 *
 * WHERE THE DATA COMES FROM (all host-sanctioned client APIs, no custom RPC)
 *   - `useSessions`   → SessionListState { ids, byId, phase }: id, title,
 *                       displayTitle, cwd, running, blank, updatedAt, origin.
 *   - `useWorkspaces` → WorkspaceSnapshot { items, archivedSessionIds }:
 *                       workspace rows plus the registry-global archive set.
 *   - `ctx.workspaces.archiveSession / unarchiveSession` → archive state writes.
 *   - `service('uiWorkspace').openSession(id)` → jump back to a conversation.
 *   - `ctx.layout.selectPanel(null)` → return the center column to the Conversation.
 *   - Per-session created time and on-disk size are NOT in those payloads; they
 *     arrive from the Host half as a projection value when available
 *     (`projectionValues.sessionManager`), otherwise the cells show "—".
 *
 * NOT IN THIS BUILD (needs the host write channel, see docs/FEASIBILITY.md #11)
 *   - permanent session delete
 *   - title (re)generation
 *   Both controls render disabled with an explanatory tooltip, so nothing fails
 *   silently.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Panel id: the sidebar row id and the `main` key must be this same string. */
    const PANEL_ID = 'session-manager'
    /** Locale namespace for every string this plugin shows. */
    const NS = 'session-manager'
    /** Sidebar row position: after Plugins (0), Schedules (10) and dsh-context (20). */
    const PANEL_ORDER = 30
    /** localStorage keys; browser-scoped state that DSH itself does not own. */
    const LS_HIDDEN = 'dsh-session-manager:hidden-workspaces:v2'
    const LS_EXPANDED = 'dsh-session-manager:expanded-workspaces:v1'
    const LS_COLUMNS = 'dsh-session-manager:columns:v1'
    const STYLE_KEY = 'dsh-session-manager/client.css'
    /** Checkbox column width; the rest come from the user's column config. */
    const SELECT_WIDTH = 22

    /**
     * Column defaults. `width` is the starting width in px; the session column is
     * the flexible one (`minmax(width, 1fr)`), every other column is fixed and
     * resizable. `min` guards a resize past usefulness.
     */
    const DEFAULT_COLUMNS = [
      { id: 'session', label: 'col.session', width: 320, visible: true },
      { id: 'workspace', label: 'col.workspace', width: 132, visible: true },
      { id: 'created', label: 'col.created', width: 96, visible: true },
      { id: 'updated', label: 'col.updated', width: 96, visible: true },
      { id: 'size', label: 'col.size', width: 78, visible: true },
      { id: 'status', label: 'col.status', width: 82, visible: true },
      { id: 'actions', label: 'col.actions', width: 76, visible: true },
    ]

    /**
     * Which columns can be sorted by clicking their header, and which sort key
     * each one drives. A column without an entry (workspace, status, actions)
     * is not clickable.
     */
    const SORTABLE = { session: 'title', created: 'created', updated: 'updated', size: 'size' }

    /** Direction a key starts in the first time it is picked. */
    const SORT_DEFAULT_DIR = { title: 'asc', created: 'desc', updated: 'desc', size: 'desc' }

    /**
     * Hard floors a column may never undercut, whatever its label says. The
     * session cell carries two lines of text, so a label-derived 56px would
     * squeeze the title into a vertical stack of characters.
     */
    const COLUMN_MIN_WIDTH = { session: 160 }

    /** Gap between grid tracks; the header and every row share it. */
    const ROW_GAP = 10

    /** What the list's own padding takes away from the pane: 6+8 left, 12+8 right. */
    const ROW_INSET = 34

    /**
     * Minimum width of one column: the explicit floor when it has one, otherwise
     * derived from its header label so the label itself never clips.
     * @param column - Column definition.
     * @param translate - Locale lookup.
     * @returns Minimum width in pixels.
     */
    function minWidthOf(column, translate) {
      const floor = COLUMN_MIN_WIDTH[column.id]
      if (typeof floor === 'number') return floor
      return columnMinWidth(translate(column.label))
    }

    /**
     * Visual length of a label, used to split the table width by name length:
     * a CJK glyph is about twice as wide as a Latin letter.
     * @param text - Label text.
     * @returns Weight in glyph units.
     */
    function textWeight(text) {
      let weight = 0
      for (const character of String(text)) {
        weight += /[\u2e80-\u9fff\uff00-\uffef]/.test(character) ? 2 : 1
      }
      return weight
    }

    /**
     * Column floor derived from the header's own label: a column can shrink until
     * its header text would clip, never further. CJK glyphs are about twice as
     * wide as Latin ones at this size, so they count double.
     * @param text - Header label.
     * @returns Minimum width in pixels.
     */
    function columnMinWidth(text) {
      let width = 0
      for (const character of String(text)) {
        width += /[\u2e80-\u9fff\uff00-\uffef]/.test(character) ? 12 : 6.6
      }
      return Math.max(56, Math.ceil(width) + 24)
    }

    /* ────────────────────────────── i18n ────────────────────────────── */

    const DICTIONARIES = {
      zh: {
        'tab.title': '会话管理',
        'page.title': '会话管理',
        'page.subtitle': '{workspaces} 个工作区 · {sessions} 个会话 · 占用 {size} · 其中 {archived} 个已归档',
        'page.subtitleNoSize': '{workspaces} 个工作区 · {sessions} 个会话 · 其中 {archived} 个已归档',
        'search.placeholder': '搜索标题、工作区或会话 ID',
        'search.clear': '清除搜索',
        'filter.all': '全部',
        'filter.normal': '正常',
        'filter.archived': '已归档',
        'filter.includeHidden': '包含已隐藏工作区',
        'filter.range': '时间',
        'filter.rangeAll': '不限时间',
        'filter.range7d': '近 7 天',
        'filter.range30d': '近 30 天',
        'filter.size': '大小',
        'filter.sizeAll': '不限大小',
        'filter.sizeSmall': '小于 1 MB',
        'filter.sizeMedium': '1–100 MB',
        'filter.sizeLarge': '大于 100 MB',
        'sort.label': '排序',
        'sort.updated': '最后活动',
        'sort.created': '创建时间',
        'sort.size': '大小',
        'sort.title': '标题',
        'sort.hint': '按「{label}」排序',
        'sort.asc': '升序',
        'sort.desc': '降序',
        'sort.toggle': '切换升序 / 降序',
        'size.split': '日志 {log} · 投影缓存 {cache}',
        'size.splitPartial': '日志 {log}',
        'action.refresh': '刷新',
        'action.expandAll': '展开全部',
        'action.collapseAll': '折叠全部',
        'tree.header': '工作区与文件结构',
        'tree.all': '全部会话',
        'tree.ungrouped': '未分类',
        'tree.hiddenGroup': '已隐藏',
        'tree.restore': '恢复显示',
        'tree.sessions': '{n} 会话',
        'col.session': '会话',
        'col.workspace': '工作区',
        'col.created': '创建',
        'col.updated': '最后活动',
        'col.size': '大小',
        'col.status': '状态',
        'col.actions': '操作',
        'columns.title': '列设置',
        'columns.hint': '拖动排序，取消勾选隐藏',
        'columns.reset': '恢复默认',
        'columns.distribute': '按字段名分配宽度',
        'columns.distributeHint': '字段名越长，分到的宽度越多；会话列保留最小可读宽度',
        'columns.needOne': '至少保留一列（会话列）',
        'columns.drag': '拖动排序',
        'columns.fixed': '该列固定显示',
        'status.normal': '正常',
        'status.archived': '已归档',
        'status.running': '运行中',
        'status.hidden': '已隐藏',
        'row.open': '打开会话',
        'row.openHint': '双击打开',
        'row.archive': '归档',
        'row.unarchive': '取消归档',
        'row.delete': '永久删除',
        'row.refreshTitle': '更新标题',
        'row.hideWorkspace': '隐藏工作区',
        'row.restoreWorkspace': '恢复显示',
        'batch.selected': '已选择 {n} 个会话',
        'batch.archive': '归档',
        'batch.unarchive': '取消归档',
        'batch.clear': '取消选择',
        'batch.hidden': '批量操作',
        'empty.none': '还没有任何会话',
        'empty.noneHint': '从左侧「新会话」开始，会话会出现在这里',
        'empty.filtered': '没有匹配的会话',
        'empty.filteredHint': '试试换个关键词，或清除筛选条件',
        'empty.clearFilters': '清除筛选',
        'loading': '读取中…',
        'unknown': '—',
        'pending.tooltip': '该操作需要宿主动作通道，下一版接入',
        'toast.archived': '已归档 {n} 个会话',
        'toast.unarchived': '已取消归档 {n} 个会话',
        'toast.failed': '{n} 个操作失败：{reason}',
        'toast.hidden': '已隐藏工作区「{name}」',
        'toast.restored': '已恢复工作区「{name}」',
        'toast.runningBlocked': '「{name}」正在运行，先停止再归档',
        'delete.title': '永久删除 {n} 个会话？',
        'delete.body': '会话日志将从磁盘删除，投影缓存随之失效。此操作无法恢复，也不会进入回收站或「已归档」。',
        'delete.more': '…以及另外 {n} 个会话',
        'delete.warn': '若这些会话正在其他窗口运行，删除会立即中断它们。',
        'delete.ack': '我已备份需要保留的内容',
        'delete.count': '输入会话数量 {n} 以确认',
        'delete.countWrong': '数量不一致，请重新输入',
        'delete.confirm': '永久删除',
        'delete.cancel': '取消',
        'toast.deleted': '已永久删除 {n} 个会话',
        'toast.deleteFailed': '{n} 个会话未删除：{reason}',
        'toast.deleteBusy': '正在删除…',
        'toast.refreshed': '已重新测量 {n} 个会话',
        'toast.refreshFailed': '重新测量失败：{reason}',
        'footnote': '显示 {shown} / {total} 个会话',
        'footnote.sizeUnknown': '大小与创建时间由宿主半计算，未就绪时显示 —',
        'time.now': '刚刚',
        'time.minutes': '{n} 分钟前',
        'time.hours': '{n} 小时前',
        'time.days': '{n} 天前',
        'time.months': '{n} 个月前',
        'time.years': '{n} 年前',
        'time.today': '今天',
      },
      en: {
        'tab.title': 'Session manager',
        'page.title': 'Session manager',
        'page.subtitle': '{workspaces} workspaces · {sessions} sessions · {size} on disk · {archived} archived',
        'page.subtitleNoSize': '{workspaces} workspaces · {sessions} sessions · {archived} archived',
        'search.placeholder': 'Search title, workspace or session id',
        'search.clear': 'Clear search',
        'filter.all': 'All',
        'filter.normal': 'Active',
        'filter.archived': 'Archived',
        'filter.includeHidden': 'Include hidden workspaces',
        'filter.range': 'Time',
        'filter.rangeAll': 'Any time',
        'filter.range7d': 'Last 7 days',
        'filter.range30d': 'Last 30 days',
        'filter.size': 'Size',
        'filter.sizeAll': 'Any size',
        'filter.sizeSmall': 'Under 1 MB',
        'filter.sizeMedium': '1–100 MB',
        'filter.sizeLarge': 'Over 100 MB',
        'sort.label': 'Sort',
        'sort.updated': 'Last activity',
        'sort.created': 'Created',
        'sort.size': 'Size',
        'sort.title': 'Title',
        'sort.hint': 'Sort by {label}',
        'sort.asc': 'Ascending',
        'sort.desc': 'Descending',
        'sort.toggle': 'Flip ascending / descending',
        'size.split': '{log} of logs · {cache} of projection cache',
        'size.splitPartial': '{log} of logs',
        'action.refresh': 'Refresh',
        'action.expandAll': 'Expand all',
        'action.collapseAll': 'Collapse all',
        'tree.header': 'Workspaces and files',
        'tree.all': 'All sessions',
        'tree.ungrouped': 'Ungrouped',
        'tree.hiddenGroup': 'Hidden',
        'tree.restore': 'Show again',
        'tree.sessions': '{n} sessions',
        'col.session': 'Session',
        'col.workspace': 'Workspace',
        'col.created': 'Created',
        'col.updated': 'Last activity',
        'col.size': 'Size',
        'col.status': 'Status',
        'col.actions': 'Actions',
        'columns.title': 'Columns',
        'columns.hint': 'Drag to reorder, clear a box to hide',
        'columns.reset': 'Reset',
        'columns.distribute': 'Split by name length',
        'columns.distributeHint': 'Longer names earn wider columns; the session column keeps a readable floor',
        'columns.needOne': 'Keep at least one column (Session)',
        'columns.drag': 'Drag to reorder',
        'columns.fixed': 'This column always shows',
        'status.normal': 'Active',
        'status.archived': 'Archived',
        'status.running': 'Running',
        'status.hidden': 'Hidden',
        'row.open': 'Open session',
        'row.openHint': 'Double-click to open',
        'row.archive': 'Archive',
        'row.unarchive': 'Unarchive',
        'row.delete': 'Delete permanently',
        'row.refreshTitle': 'Refresh title',
        'row.hideWorkspace': 'Hide workspace',
        'row.restoreWorkspace': 'Show workspace',
        'batch.selected': '{n} selected',
        'batch.archive': 'Archive',
        'batch.unarchive': 'Unarchive',
        'batch.clear': 'Clear selection',
        'batch.hidden': 'Bulk actions',
        'empty.none': 'No sessions yet',
        'empty.noneHint': 'Start one from New session; it will show up here',
        'empty.filtered': 'No matching sessions',
        'empty.filteredHint': 'Try another keyword or clear the filters',
        'empty.clearFilters': 'Clear filters',
        'loading': 'Loading…',
        'unknown': '—',
        'pending.tooltip': 'Needs the host action channel; arriving in the next version',
        'toast.archived': 'Archived {n} sessions',
        'toast.unarchived': 'Unarchived {n} sessions',
        'toast.failed': '{n} operations failed: {reason}',
        'toast.hidden': 'Hidden workspace “{name}”',
        'toast.restored': 'Restored workspace “{name}”',
        'toast.runningBlocked': '“{name}” is running; stop it before archiving',
        'delete.title': 'Delete {n} sessions permanently?',
        'delete.body': 'The session logs are removed from disk and their projection caches stop working. This cannot be undone and does not go to Archived or a trash.',
        'delete.more': '…and {n} more sessions',
        'delete.warn': 'Sessions running in another window are interrupted immediately.',
        'delete.ack': 'I have backed up anything I need',
        'delete.count': 'Type the session count ({n}) to confirm',
        'delete.countWrong': 'That does not match',
        'delete.confirm': 'Delete permanently',
        'delete.cancel': 'Cancel',
        'toast.deleted': 'Deleted {n} sessions permanently',
        'toast.deleteFailed': '{n} sessions were not deleted: {reason}',
        'toast.deleteBusy': 'Deleting…',
        'toast.refreshed': 'Re-measured {n} sessions',
        'toast.refreshFailed': 'Re-measuring failed: {reason}',
        'footnote': 'Showing {shown} of {total} sessions',
        'footnote.sizeUnknown': 'Sizes and created times come from the Host half; “—” means not ready',
        'time.now': 'just now',
        'time.minutes': '{n}m ago',
        'time.hours': '{n}h ago',
        'time.days': '{n}d ago',
        'time.months': '{n}mo ago',
        'time.years': '{n}y ago',
        'time.today': 'Today',
      },
    }

    /* ───────────────────────────── styles ───────────────────────────── */

    const CSS = `
.dsm-page {
  flex: 1 1 auto; min-width: 0; min-height: 0;
  display: flex; flex-direction: column;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  /* Dark lifts with white overlays, light sinks with black ones. Every value
     that has to differ between the two lives here, in one place. */
  --dsm-head-tint: rgba(255, 255, 255, .03);
  --dsm-line: var(--dsw-alias-border-l1);
  --dsm-line-strong: var(--dsw-alias-border-l1);
  --dsm-row-rule: rgba(255, 255, 255, .045);
  --dsm-row-gap: 2px;
  --dsm-row-radius: var(--dsw-radius-sm, 8px);
  --dsm-rail-row: rgba(255, 255, 255, .04);
  --dsm-rail-head: rgba(255, 255, 255, .06);
  --dsm-rail-edge: transparent;
  --dsm-sep-color: var(--dsw-alias-border-l3);
  --dsm-sep-rest: 0;
  --dsm-sep-height: 16px;
  --dsm-foot-tint: rgba(255, 255, 255, .02);
}
/* On white, "a little brighter" is invisible: the same layers become black
   tints, the rules get real contrast, and the column dividers stay on. */
.dsm-page[data-scheme="light"] {
  --dsm-head-tint: rgba(0, 0, 0, .04);
  --dsm-line: rgba(0, 0, 0, .10);
  --dsm-line-strong: rgba(0, 0, 0, .13);
  --dsm-row-rule: rgba(0, 0, 0, .07);
  --dsm-row-gap: 0;
  --dsm-row-radius: 0;
  --dsm-rail-row: rgba(0, 0, 0, .035);
  --dsm-rail-head: rgba(0, 0, 0, .05);
  --dsm-rail-edge: rgba(0, 0, 0, .09);
  --dsm-sep-color: rgba(0, 0, 0, .14);
  --dsm-sep-rest: 1;
  --dsm-sep-height: 22px;
  --dsm-foot-tint: rgba(0, 0, 0, .02);
}
.dsm-page * { box-sizing: border-box; }

/* header */
.dsm-head { display: flex; align-items: flex-start; gap: 16px; padding: 18px 20px 14px; }
.dsm-title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsm-title h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: .1px; }
.dsm-sub { margin: 0; color: var(--dsw-alias-label-caption); font-size: 12px; }
.dsm-sub b { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dsm-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }

.dsm-search {
  display: flex; align-items: center; gap: 7px;
  width: 250px; height: 30px; padding: 0 9px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption);
}
.dsm-search input {
  flex: 1 1 auto; min-width: 0; height: 100%;
  background: none; border: 0; outline: none;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px;
}
.dsm-search input::placeholder { color: var(--dsw-alias-label-caption); }
.dsm-search button {
  flex: none; width: 18px; height: 18px; display: grid; place-items: center;
  border: 0; padding: 0; background: none; color: var(--dsw-alias-label-caption); cursor: pointer;
}
.dsm-search button:hover { color: var(--dsw-alias-label-primary); }

.dsm-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 11px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap;
}
.dsm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsm-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsm-btn.is-danger { color: var(--dsw-alias-state-error-primary); border-color: rgba(242, 90, 90, .4); }
.dsm-btn.is-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsm-btn.is-quiet { border-color: transparent; color: var(--dsw-alias-label-tertiary); }
.dsm-btn.is-quiet:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }

/* filter bar */
.dsm-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 0 20px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsm-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; background: none; cursor: pointer;
}
.dsm-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsm-chip.is-on {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
.dsm-chip .n { color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dsm-chip.is-on .n { color: var(--dsw-alias-label-secondary); }
.dsm-bar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dsm-field { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-caption); font-size: 12px; white-space: nowrap; }
.dsm-btn.is-icon { width: 26px; height: 26px; padding: 0; justify-content: center; }
/* Search hits inside a title or workspace name. */
.dsm-mark { background: rgba(122, 170, 255, .3); color: var(--dsw-alias-label-primary); border-radius: 2px; }
.dsm-select {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 9px; border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; cursor: pointer;
}
.dsm-select:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* The popup itself is painted by the browser: colour-scheme (set on the page
   from the host theme) decides whether it opens dark, and these two lines are
   the fallback for builds that ignore it. */
.dsm-select option { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsm-divider { width: 1px; height: 16px; background: var(--dsm-line-strong); }

/* body */
.dsm-body { flex: 1 1 auto; display: flex; min-height: 0; }

/* tree */
.dsm-tree {
  width: 322px; flex: none; display: flex; flex-direction: column; gap: 1px;
  border-right: 1px solid var(--dsm-line);
  padding: 10px 8px 16px; overflow: auto;
}
.dsm-tree-head {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 8px 8px; color: var(--dsw-alias-label-caption); font-size: 12px;
}
.dsm-tree-head .sp { margin-left: auto; display: flex; gap: 8px; }
.dsm-tree-head button { border: 0; background: none; padding: 0; font: inherit; color: var(--dsw-alias-label-caption); cursor: pointer; }
.dsm-tree-head button:hover { color: var(--dsw-alias-label-primary); }

.dsm-node {
  display: flex; align-items: center; gap: 6px;
  min-height: 30px; padding: 4px 6px; border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-secondary); font-size: 13px;
  border: 0; background: none; font-family: inherit; text-align: left; width: 100%; cursor: pointer;
}
.dsm-node:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsm-node.is-sel { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.dsm-node.is-hidden .dsm-node-label { color: var(--dsw-alias-label-tertiary); }
.dsm-caret {
  width: 12px; flex: none; display: grid; place-items: center;
  color: var(--dsw-alias-label-caption); transition: transform .12s ease;
}
.dsm-caret.is-open { transform: rotate(90deg); }
.dsm-node-ico { width: 15px; flex: none; display: grid; place-items: center; color: var(--dsw-alias-label-tertiary); }
.dsm-node-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-node-agg {
  flex: none; display: flex; gap: 8px; white-space: nowrap;
  color: var(--dsw-alias-label-caption); font-size: 11.5px; font-variant-numeric: tabular-nums;
}
.dsm-children { margin-left: 20px; display: flex; flex-direction: column; gap: 1px; }
.dsm-leaf {
  display: flex; align-items: center; gap: 7px; width: 100%;
  min-height: 27px; padding: 3px 6px; border-radius: var(--dsw-radius-xs, 4px);
  border: 0; background: none; font-family: inherit; text-align: left; cursor: pointer;
  color: var(--dsw-alias-label-tertiary); font-size: 12.5px;
}
.dsm-leaf:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dsm-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-success-primary); }
.dsm-dot.is-arch { background: var(--dsw-alias-label-caption); }
.dsm-dot.is-run { background: var(--dsw-alias-state-business-primary); }
.dsm-leaf-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-leaf-size { flex: none; font-size: 11px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dsm-tree-sub {
  display: flex; align-items: center; gap: 6px;
  margin-top: 10px; padding: 8px 8px 4px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption); font-size: 12px;
}
.dsm-tree-sub .sp { margin-left: auto; }
.dsm-tree-sub button { border: 0; background: none; padding: 0; font: inherit; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dsm-tree-sub button:hover { color: var(--dsw-alias-label-primary); }

/* list */
.dsm-list { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.dsm-thead, .dsm-row {
  display: grid;
  /* template comes from the column config as an inline style */
  gap: 10px; align-items: center;
}
.dsm-thead > *, .dsm-row > * { min-width: 0; }
/* Headers centre their labels; the body content centres with them. */
.dsm-th { position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; }
.dsm-row > * { text-align: center; }
.dsm-row .dsm-session { align-items: stretch; }
.dsm-row .dsm-ws-tag,
.dsm-row .dsm-actions,
.dsm-row .dsm-cell { justify-content: center; }
.dsm-row.is-active { box-shadow: inset 0 0 0 1px rgba(122, 170, 255, .5); }
.dsm-row.is-flash { animation: dsm-flash .6s ease-out 1; }
@keyframes dsm-flash {
  0% { background-color: rgba(122, 170, 255, .24); }
  100% { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .dsm-row.is-flash { animation: none; background-color: rgba(122, 170, 255, .12); }
}
/* A column divider hangs on the header cell itself rather than on the drag
   handle, so hovering anywhere in the header bar reveals every boundary at
   once instead of only the one under the pointer. */
.dsm-th:not(.is-actions):not(.is-flex)::after {
  content: ''; position: absolute; right: -5px; top: 50%; transform: translate(50%, -50%);
  width: 1px; height: var(--dsm-sep-height); border-radius: 1px; pointer-events: none;
  background: var(--dsm-sep-color);
  opacity: var(--dsm-sep-rest); transition: opacity .12s ease;
}
.dsm-thead:hover .dsm-th:not(.is-actions):not(.is-flex)::after,
.dsm-thead:focus-within .dsm-th:not(.is-actions):not(.is-flex)::after { opacity: 1; }
/* The boundary a drag would move reads in the accent colour. The selector keeps
   the same shape as the rule above, so it wins over the resting styles. */
.dsm-thead .dsm-th:not(.is-actions):not(.is-flex):hover::after {
  width: 2px; opacity: 1; background: var(--dsw-alias-state-business-primary);
}
@media (prefers-reduced-motion: reduce) { .dsm-th::after { transition: none; } }
.dsm-resizer {
  position: absolute; top: -9px; right: -8px; width: 13px; height: 30px;
  cursor: col-resize; z-index: 2; background: none; border: 0; padding: 0;
}
/* A sortable header is a button, so sorting lives on the header itself while the
   drag handle beside it keeps its own hit area. */
.dsm-th-sort {
  display: inline-flex; align-items: center; gap: 3px;
  border: 0; padding: 0; background: none;
  font: inherit; color: var(--dsw-alias-label-caption); cursor: pointer;
  border-radius: 4px;
}
.dsm-th-sort:hover { color: var(--dsw-alias-label-secondary); }
.dsm-th-sort.is-on { color: var(--dsw-alias-label-secondary); }
.dsm-th-sort:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dsm-th-sort .dsm-th-dir { display: inline-grid; place-items: center; color: var(--dsw-alias-state-business-primary); }
/* The actions column is a rail, not a data column: no divider next to it, a
   tinted band instead — in the header and down every row. The negative right
   margin reaches the row's own edge so the band, the row radius and the header
   band all land on the same vertical line. */
.dsm-th.is-actions {
  align-self: stretch;
  margin: -9px -8px -9px 0; padding: 9px 8px 9px 0;
  border-radius: 0 8px 8px 0;
  background: var(--dsm-rail-head);
  box-shadow: inset 1px 0 0 var(--dsm-rail-edge);
}
.dsm-row .dsm-actions {
  align-self: stretch; align-items: center;
  margin: -8px -8px -8px 0; padding: 8px 8px 8px 0;
  border-radius: 0 var(--dsm-row-radius) var(--dsm-row-radius) 0;
  background: var(--dsm-rail-row);
  box-shadow: inset 1px 0 0 var(--dsm-rail-edge);
}

.dsm-cols {
  position: fixed; z-index: 65; width: 250px; padding: 8px;
  border-radius: var(--dsw-radius-md, 12px);
  /* A floating surface follows the theme; a hard-coded dark panel would put
     dark labels on a dark fill in light mode. */
  background: var(--dsw-alias-bg-layer-3, rgba(48, 49, 54, .94));
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 14px 38px rgba(0, 0, 0, .5); backdrop-filter: blur(18px);
}
.dsm-cols-head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsm-cols-head button {
  margin-left: auto; border: 0; background: none; font: inherit; font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.dsm-cols-head button:hover { color: var(--dsw-alias-label-primary); }
.dsm-cols-row {
  display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px;
  border-radius: var(--dsw-radius-sm, 8px); font-size: 12.5px; color: var(--dsw-alias-label-primary);
}
.dsm-cols-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsm-cols-row.is-drag { opacity: .4; }
.dsm-cols-row.is-over { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.dsm-cols-grip { width: 14px; display: grid; place-items: center; color: var(--dsw-alias-label-caption); cursor: grab; }
.dsm-cols-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-cols-hint { padding: 5px 6px 0; color: var(--dsw-alias-label-caption); font-size: 11px; }
.dsm-cols-foot { padding: 9px 4px 2px; }
.dsm-cols-action {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; height: 27px; padding: 0 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.dsm-cols-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.dsm-scrim {
  position: fixed; inset: 0; z-index: 66;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .5));
  display: grid; place-items: center; animation: dsm-fade .12s ease-out;
}
@keyframes dsm-fade { from { opacity: 0 } to { opacity: 1 } }
.dsm-dialog {
  width: 410px; max-width: calc(100vw - 40px); padding: 18px;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 24px 60px rgba(0, 0, 0, .55);
  display: flex; flex-direction: column; gap: 10px;
}
.dsm-dialog h3 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.dsm-dialog p { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dsm-dlist {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1); padding: 7px 9px;
  display: flex; flex-direction: column; gap: 5px; max-height: 134px; overflow: auto;
}
.dsm-dli { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsm-dli .nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-dli .sz { color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dsm-dwarn { display: flex; gap: 7px; color: var(--dsw-alias-state-warn-primary); font-size: 12px; align-items: flex-start; }
.dsm-ack { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsm-dialog input[type="text"] {
  height: 28px; padding: 0 8px; border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; outline: none;
}
.dsm-dialog input[type="text"]:focus-visible { border-color: var(--dsw-alias-border-l4); }
.dsm-dactions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.dsm-btn.is-solid-danger { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #1a0f0f; font-weight: 600; }
.dsm-btn.is-solid-danger:disabled { opacity: .5; }
.dsm-count-wrong { color: var(--dsw-alias-state-error-primary); font-size: 11.5px; }
.dsm-thead {
  /* Sticky inside the scroll container, with an opaque band under it: the rows
     scroll past without smearing through the header. */
  position: sticky; top: 0; z-index: 2;
  padding: 9px 20px 9px 14px;
  background-color: var(--dsw-alias-bg-base, #17181a);
  background-image: linear-gradient(var(--dsm-head-tint), var(--dsm-head-tint));
  border-bottom: 1px solid var(--dsm-line-strong);
  color: var(--dsw-alias-label-caption); font-size: 11.5px;
}
.dsm-thead .r { text-align: right; }
.dsm-rows {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 4px 0 8px;
  display: flex; flex-direction: column; gap: var(--dsm-row-gap);
}
.dsm-row {
  padding: 8px; margin: 0 12px 0 6px;
  border-radius: var(--dsm-row-radius);
  border-bottom: 1px solid var(--dsm-row-rule);
  /* Leaves room for the sticky header when a located row is scrolled into view. */
  scroll-margin-top: 44px;
  color: var(--dsw-alias-label-secondary);
}
.dsm-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsm-row.is-checked { background: rgba(122, 170, 255, .09); }
.dsm-cell { font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsm-cell.r { text-align: right; }
.dsm-session { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
/* Up to three lines, then an ellipsis; the full title stays on the title
   attribute, so hovering always reveals it. */
.dsm-session-name {
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.42;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3;
  overflow: hidden; overflow-wrap: anywhere;
}
/* Time and id share one line: the id gives way first, the time never wraps. */
.dsm-session-meta {
  color: var(--dsw-alias-label-caption); font-size: 11.5px;
  display: flex; gap: 6px; align-items: center; justify-content: center;
  white-space: nowrap; min-width: 0;
}
.dsm-session-meta > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsm-session-meta > span:nth-child(-n+2) { flex: none; }
.dsm-mono { font-family: var(--dsw-font-family-code, monospace); font-size: 11px; }
.dsm-ws-tag { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsm-ws-tag span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-ws-tag.is-hidden { color: var(--dsw-alias-state-warn-primary); }

.dsm-cbx {
  width: 14px; height: 14px; padding: 0; border-radius: 3px;
  border: 1px solid var(--dsw-alias-border-l3); background: transparent;
  display: grid; place-items: center; cursor: pointer;
}
.dsm-cbx.is-on { background: var(--dsw-alias-brand-primary-new-colorprimary-new-color, rgb(86,134,254)); border-color: transparent; }
.dsm-cbx.is-on::after {
  content: ''; width: 7px; height: 4px;
  border-left: 1.5px solid #fff; border-bottom: 1.5px solid #fff;
  transform: rotate(-45deg) translateY(-1px);
}

.dsm-pill {
  display: inline-flex; align-items: center; gap: 5px;
  height: 20px; padding: 0 7px; border-radius: 999px;
  font-size: 11.5px; border: 1px solid transparent; white-space: nowrap;
}
.dsm-pill .d { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.dsm-pill.is-ok { color: var(--dsw-alias-state-success-primary); background: rgba(34,197,94,.1); border-color: rgba(34,197,94,.22); }
.dsm-pill.is-run { color: var(--dsw-alias-state-business-primary); background: rgba(122,170,255,.12); border-color: rgba(122,170,255,.24); }
.dsm-pill.is-arch { color: var(--dsw-alias-label-tertiary); background: rgba(255,255,255,.05); border-color: var(--dsw-alias-border-l1); }
.dsm-pill.is-hidden { color: var(--dsw-alias-state-warn-primary); background: rgba(245,158,11,.1); border-color: rgba(245,158,11,.24); }

.dsm-actions { display: flex; justify-content: flex-end; gap: 2px; }
.dsm-ico-btn {
  width: 24px; height: 24px; display: grid; place-items: center;
  border: 0; border-radius: var(--dsw-radius-xs, 4px); background: none;
  color: var(--dsw-alias-label-caption); cursor: pointer;
}
.dsm-ico-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsm-ico-btn:disabled { opacity: .35; cursor: not-allowed; }
.dsm-ico-btn.is-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsm-row .dsm-actions .dsm-ico-btn { opacity: 1; }

/* batch bar */
.dsm-batch {
  display: flex; align-items: center; gap: 10px;
  margin: 0 20px 14px; padding: 9px 12px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .45);
}
.dsm-batch .n { font-size: 12.5px; font-weight: 500; }
.dsm-batch .sp { margin-left: auto; }

.dsm-foot {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 20px; margin-top: 2px;
  border-top: 1px solid var(--dsm-line);
  background-image: linear-gradient(var(--dsm-foot-tint), var(--dsm-foot-tint));
  color: var(--dsw-alias-label-caption); font-size: 11px;
}

/* empty */
.dsm-empty {
  flex: 1 1 auto; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px;
  color: var(--dsw-alias-label-caption); padding: 40px 20px;
}
.dsm-empty .h { color: var(--dsw-alias-label-secondary); font-size: 13.5px; }

/* menu + toast */
.dsm-menu {
  position: fixed; z-index: 60; min-width: 186px; padding: 5px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-3, rgba(48, 49, 54, .92));
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 14px 38px rgba(0, 0, 0, .5);
  backdrop-filter: blur(18px);
  display: flex; flex-direction: column; gap: 1px;
}
.dsm-menu-item {
  display: flex; align-items: center; gap: 9px;
  height: 30px; padding: 0 9px; border: 0; border-radius: var(--dsw-radius-sm, 8px);
  background: none; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; cursor: pointer; text-align: left; white-space: nowrap;
}
.dsm-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsm-menu-item:disabled { opacity: .45; cursor: not-allowed; }
.dsm-menu-item.is-danger { color: var(--dsw-alias-state-error-primary); }
.dsm-menu-item.is-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsm-menu-sep { height: 1px; margin: 4px 8px; background: var(--dsw-alias-border-l1); }

.dsm-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 70; max-width: 460px;
  padding: 9px 14px; border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-toast-bg, rgb(67,69,74));
  color: var(--dsw-alias-toast-label, #fff);
  font-size: 12.5px; box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
}

/* ── light scheme: same structure, one step stronger ───────────────── */
.dsm-page[data-scheme="light"] .dsm-thead { color: var(--dsw-alias-label-secondary); }
.dsm-page[data-scheme="light"] .dsm-cell { color: var(--dsw-alias-label-secondary); }
.dsm-page[data-scheme="light"] .dsm-ws-tag { color: var(--dsw-alias-label-secondary); }
.dsm-page[data-scheme="light"] .dsm-ico-btn { color: var(--dsw-alias-label-tertiary); }
.dsm-page[data-scheme="light"] .dsm-empty { color: var(--dsw-alias-label-secondary); }
.dsm-page[data-scheme="light"] .dsm-tree-head button { color: var(--dsw-alias-label-tertiary); }
/* An untouched checkbox still has to read as a box on white. */
.dsm-page[data-scheme="light"] .dsm-cbx { border-width: 1.5px; border-color: var(--dsw-alias-label-tertiary); }
/* 9% blue is a whisper on white; 14% is a state. */
.dsm-page[data-scheme="light"] .dsm-row.is-checked { background: rgba(122, 170, 255, .14); }
.dsm-page[data-scheme="light"] .dsm-node.is-sel { background: rgba(122, 170, 255, .12); }
.dsm-page[data-scheme="light"] .dsm-pill.is-arch {
  background: rgba(0, 0, 0, .045);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.dsm-page[data-scheme="light"] .dsm-toast {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
`

    /* ───────────────────────────── icons ───────────────────────────── */

    const ICONS = {
      chat: 'M4.4 2.6h7.2a2.4 2.4 0 0 1 2.4 2.4v3.4a2.4 2.4 0 0 1-2.4 2.4H8.4L6 13.1v-2.3H4.4A2.4 2.4 0 0 1 2 8.4V5a2.4 2.4 0 0 1 2.4-2.4Z',
      folder: 'M1.9 4.4V12a1.4 1.4 0 0 0 1.4 1.4h9.4A1.4 1.4 0 0 0 14.1 12V6.1a1.4 1.4 0 0 0-1.4-1.4H8.2L6.7 3.1H3.3a1.4 1.4 0 0 0-1.4 1.3Z',
      layers: 'm8 2.4 5.6 2.9L8 8.2 2.4 5.3 8 2.4Zm-5.6 6 5.6 2.9 5.6-2.9M2.4 11.2l5.6 2.9 5.6-2.9',
      chev: 'M6 3.5 10.5 8 6 12.5',
      dots: 'M3.2 8a1.15 1.15 0 1 0 0-.01M8 8a1.15 1.15 0 1 0 0-.01M12.8 8a1.15 1.15 0 1 0 0-.01',
      archive: 'M3.4 5.7v6.2a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2V5.7M2.2 3.9h11.6v2.8H2.2zM6.4 8.6h3.2',
      unarchive: 'M3.4 5.7v6.2a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2V5.7M2.2 3.9h11.6v2.8H2.2zM8 7.4v4M6.4 9l1.6-1.6L9.6 9',
      trash: 'M2.8 4.4h10.4M6.2 4.4V3a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.4M4.2 4.4l.6 8a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-8',
      pencil: 'M10.3 2.9 13.1 5.7 5.6 13.2l-3.1.6.6-3.1 7.2-7.8Z',
      eyeOff: 'M2.4 8S4.7 4.3 8 4.3 13.6 8 13.6 8 11.3 11.7 8 11.7 2.4 8 2.4 8Z M6.5 6.5a2 2 0 0 0 2.8 2.8M3.2 3.2l9.6 9.6',
      refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 3.1v2.6h-2.6',
      search: 'M11.4 11.4 14 14M10.4 7.2a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0Z',
      sort: 'M4.4 3.4v9.2M2.3 10.5l2.1 2.1 2.1-2.1M9 5.2h4.6M9 8h3.2M9 10.8h1.9',
      arrowUp: 'M8 12.6V3.4M4.9 6.5 8 3.4l3.1 3.1',
      arrowDown: 'M8 3.4v9.2M4.9 9.5 8 12.6l3.1-3.1',
      close: 'M4 4l8 8M12 4l-8 8',
      warn: 'M8 2.6 14 13H2L8 2.6ZM8 6.4v3.2M8 11.4v.1',
      open: 'M9.2 2.8h4v4M13.2 2.8 7.6 8.4M12.4 9.6v2.6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V5a1.4 1.4 0 0 1 1.4-1.4h2.6',
    }

    function Icon({ name, size = 14, className, style }) {
      const svgProps = {
        width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false', className, style,
      }
      if (name === 'dots') {
        return h('svg', svgProps,
          h('circle', { cx: 3.2, cy: 8, r: 1.15, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 8, cy: 8, r: 1.15, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 12.8, cy: 8, r: 1.15, fill: 'currentColor', stroke: 'none' }))
      }
      return h('svg', svgProps, h('path', { d: ICONS[name] || ICONS.chat }))
    }

    /* ──────────────────────────── helpers ──────────────────────────── */

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return parsed == null ? fallback : parsed
      } catch { return fallback }
    }

    function writeJson(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ }
    }

    /**
     * Whether the host is painting a dark or a light surface. Native dropdown
     * popups and scrollbars are drawn by the browser and follow the page's
     * `color-scheme`, so guessing wrong puts a white menu on a dark page.
     * @returns 'dark' or 'light'.
     */
    function detectColorScheme() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return 'dark'
      try {
        const luminance = (raw) => {
          const match = /rgba?\(([^)]+)\)/.exec(String(raw || ''))
          if (match === null) return null
          const parts = match[1].split(',').map(value => Number.parseFloat(value))
          const [red, green, blue, alpha = 1] = parts
          if (![red, green, blue].every(value => Number.isFinite(value)) || alpha < 0.2) return null
          return 0.299 * red + 0.587 * green + 0.114 * blue
        }
        for (const element of [document.body, document.documentElement]) {
          if (!element) continue
          const value = luminance(window.getComputedStyle(element).backgroundColor)
          if (value !== null) return value < 128 ? 'dark' : 'light'
        }
        // A fully transparent shell still has a text colour that tells the two apart.
        const text = luminance(window.getComputedStyle(document.body).color)
        if (text !== null) return text > 128 ? 'dark' : 'light'
      } catch { /* the host owns the theme; fall through to its default */ }
      return 'dark'
    }

    /**
     * Merge the stored column config with the defaults: unknown ids are dropped,
     * new built-in columns appear at the end, and a stored width/min drives the
     * grid. A corrupt entry falls back to the defaults instead of breaking the table.
     * @param stored - Raw localStorage value.
     * @returns Normalised column list in display order.
     */
    function normaliseColumns(stored) {
      const byId = new Map(DEFAULT_COLUMNS.map(column => [column.id, column]))
      const out = []
      const seen = new Set()
      if (Array.isArray(stored)) {
        for (const entry of stored) {
          if (entry === null || typeof entry !== 'object') continue
          const base = byId.get(entry.id)
          if (base === undefined || seen.has(entry.id)) continue
          seen.add(entry.id)
          // A stored width may come from an older build (or be corrupt): clamp it
          // instead of trusting it, because a non-finite width turns the whole
          // grid-template declaration into invalid CSS and collapses the table.
          // A column with a hard floor is also lifted back to it, so a squeezed
          // column from an older build arrives readable.
          const stored = Number(entry.width)
          const floor = COLUMN_MIN_WIDTH[entry.id]
          const minimum = typeof floor === 'number' ? floor : 40
          const width = Number.isFinite(stored) ? Math.max(minimum, Math.round(stored)) : Math.max(minimum, base.width)
          out.push({ ...base, width, visible: entry.visible !== false })
        }
      }
      for (const column of DEFAULT_COLUMNS) {
        if (!seen.has(column.id)) out.push({ ...column })
      }
      // The session column is the table's spine and the actions column is its
      // control surface: neither can be hidden.
      return out.map(column => (
        column.id === 'session' || column.id === 'actions' ? { ...column, visible: true } : column
      ))
    }

    function loadColumns() {
      return normaliseColumns(readJson(LS_COLUMNS, null))
    }

    function saveColumns(columns) {
      writeJson(LS_COLUMNS, columns.map(({ id, width, visible }) => ({ id, width, visible })))
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return null
      if (bytes < 1024) return bytes + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
      return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit]
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n) }

    /** Relative time in the host's wording; mirrors the sidebar's buckets. */
    function relativeTime(ms, now, t) {
      if (typeof ms !== 'number' || !isFinite(ms)) return t('unknown')
      const diff = Math.max(0, now - ms)
      const minute = 60000
      const hour = 3600000
      const day = 86400000
      if (diff < minute) return t('time.now')
      if (diff < hour) return t('time.minutes', { n: Math.floor(diff / minute) })
      if (diff < day) return t('time.hours', { n: Math.floor(diff / hour) })
      if (diff < 30 * day) return t('time.days', { n: Math.floor(diff / day) })
      if (diff < 365 * day) return t('time.months', { n: Math.floor(diff / (30 * day)) })
      return t('time.years', { n: Math.floor(diff / (365 * day)) })
    }

    function absoluteTime(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return null
      const d = new Date(ms)
      const now = new Date()
      const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
      if (d.toDateString() === now.toDateString()) return { day: 'today', text: time }
      return { day: 'other', text: (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + time }
    }

    function fmtAbs(ms, t) {
      const abs = absoluteTime(ms)
      if (abs === null) return t('unknown')
      return abs.day === 'today' ? t('time.today') + ' ' + abs.text.slice(0, 5) : abs.text
    }

    /** Short workspace label: the last path segment, or the title. */
    function workspaceLabel(path, title) {
      if (title && title.trim()) return title
      if (!path) return ''
      const parts = String(path).split(/[\\/]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : path
    }

    function idPrefix(id) {
      const value = String(id || '')
      const match = value.match(/session-([0-9a-f]{8})/i)
      if (match) return match[1]
      return value.slice(-8)
    }

    /**
     * Split a text into plain runs and `<mark>` runs that match the search, so a
     * hit is visible where it happens instead of only removing rows.
     * @param text - Text to split.
     * @param needle - Raw search input; trimmed, case-insensitive.
     * @returns Array of strings and highlighted elements.
     */
    function highlightHits(text, needle) {
      const source = String(text === null || text === undefined ? '' : text)
      const query = String(needle === null || needle === undefined ? '' : needle).trim()
      if (query === '' || source === '') return [source]
      const haystack = source.toLowerCase()
      const target = query.toLowerCase()
      const parts = []
      let from = 0
      let at = haystack.indexOf(target)
      let guard = 0
      while (at >= 0 && guard < 32) {
        if (at > from) parts.push(source.slice(from, at))
        parts.push(h('mark', { key: 'hit' + at, className: 'dsm-mark' }, source.slice(at, at + target.length)))
        from = at + target.length
        at = haystack.indexOf(target, from)
        guard += 1
      }
      if (from < source.length) parts.push(source.slice(from))
      return parts
    }

    /**
     * Ask the Host half for per-session facts (created time, on-disk bytes).
     * The route is registered on the authenticated `connection` channel, so a
     * relative request rides the page's own origin and credentials.
     * @param ids - Session ids to describe.
     * @param options - `{ refresh: true }` makes the Host re-measure instead of
     *   answering from its 30s cache; that is what the 刷新 button sends.
     * @returns Map of id → `{ createdAt, bytes, logBytes, cacheBytes, dir }`.
     */
    async function requestStats(ids, options) {
      if (!Array.isArray(ids) || ids.length === 0) return {}
      const refresh = options !== null && typeof options === 'object' && options.refresh === true
      const response = await fetch('api/dsh-session-manager/stats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(refresh ? { ids, refresh: true } : { ids }),
      })
      if (!response.ok) throw new Error('stats request failed: HTTP ' + response.status)
      const payload = await response.json()
      if (payload === null || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message
        throw new Error(message || 'stats request failed')
      }
      return payload.value && typeof payload.value === 'object' ? payload.value : {}
    }

    /**
     * POST one JSON request to a plugin route and unwrap its envelope.
     * @param path - Route path relative to the page origin.
     * @param body - JSON body.
     * @returns The envelope's `value`.
     */
    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('request failed: HTTP ' + response.status)
      const payload = await response.json()
      if (payload === null || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message
        throw new Error(message || 'request failed')
      }
      return payload.value
    }

    /** Ask the Host to archive and unregister one workspace. */
    function requestHide(workspaceId) {
      return postJson('api/dsh-session-manager/hide', { workspaceId })
    }

    /** Ask the Host to re-register a hidden workspace and re-attach its sessions. */
    function requestRestore(record) {
      return postJson('api/dsh-session-manager/restore', { record })
    }

    /**
     * Permanently delete sessions through the Host half.
     * Resolves with `{ deleted: string[], failed: [{ id, code, message }] }`.
     * @param ids - Session ids to delete.
     */
    async function requestDelete(ids) {
      const response = await fetch('api/dsh-session-manager/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!response.ok) throw new Error('delete request failed: HTTP ' + response.status)
      const payload = await response.json()
      if (payload === null || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message
        throw new Error(message || 'delete request failed')
      }
      return payload.value || { deleted: [], failed: [] }
    }

    /**
     * Host-published per-session facts (created time + on-disk size).
     * Absent until the Host half answers, so every caller must tolerate null.
     */
    function statsOf(summary, projectionsBySession) {
      const direct = summary && summary.projectionValues && summary.projectionValues.sessionManager
      if (direct && typeof direct === 'object') return direct
      const snapshot = summary && projectionsBySession && projectionsBySession[summary.id]
      const values = snapshot && snapshot.values
      const nested = values && values.sessionManager
      return nested && typeof nested === 'object' ? nested : null
    }

    /* ──────────────────────────── components ───────────────────────── */

    function Toolbar({
      t, status, onStatus, counts, sortKey, onSort, sortDir, onFlipDir,
      includeHidden, onIncludeHidden, range, onRange, sizeBand, onSizeBand,
      onRefresh, refreshing,
    }) {
      const chips = [
        ['all', t('filter.all'), counts.all],
        ['normal', t('filter.normal'), counts.normal],
        ['archived', t('filter.archived'), counts.archived],
      ]
      const sorts = [['updated', t('sort.updated')], ['created', t('sort.created')], ['size', t('sort.size')], ['title', t('sort.title')]]
      const ranges = [['all', t('filter.rangeAll')], ['7d', t('filter.range7d')], ['30d', t('filter.range30d')]]
      const sizes = [
        ['all', t('filter.sizeAll')], ['small', t('filter.sizeSmall')],
        ['medium', t('filter.sizeMedium')], ['large', t('filter.sizeLarge')],
      ]
      const selectStyle = { background: 'none', border: 0, color: 'inherit', font: 'inherit', outline: 'none', cursor: 'pointer' }
      const picker = (field, label, value, options, onChange) => h('label', { className: 'dsm-field' },
        h('span', null, label),
        h('span', { className: 'dsm-select' },
          h('select', {
            value,
            'data-field': field,
            'aria-label': label,
            onChange: event => onChange(event.target.value),
            style: selectStyle,
          }, options.map(([key, text]) => h('option', { key, value: key }, text)))))
      return h('div', { className: 'dsm-bar' },
        chips.map(([key, label, count]) => h('button', {
          key, type: 'button',
          className: 'dsm-chip' + (status === key ? ' is-on' : ''),
          onClick: () => onStatus(key),
        }, label, h('span', { className: 'n' }, String(count)))),
        h('span', { className: 'dsm-divider' }),
        h('button', {
          type: 'button',
          className: 'dsm-chip' + (includeHidden ? ' is-on' : ''),
          'aria-pressed': includeHidden ? 'true' : 'false',
          onClick: () => onIncludeHidden(!includeHidden),
        }, t('filter.includeHidden')),
        h('div', { className: 'dsm-bar-right' },
          picker('range', t('filter.range'), range, ranges, onRange),
          picker('size', t('filter.size'), sizeBand, sizes, onSizeBand),
          h('span', { className: 'dsm-divider' }),
          h('label', { className: 'dsm-select', title: t('sort.label') },
            h(Icon, { name: 'sort', size: 12 }),
            h('select', {
              value: sortKey,
              'data-field': 'sort',
              'aria-label': t('sort.label'),
              onChange: event => onSort(event.target.value),
              style: selectStyle,
            }, sorts.map(([key, label]) => h('option', { key, value: key }, label)))),
          h('button', {
            type: 'button',
            className: 'dsm-btn is-quiet is-icon',
            title: t('sort.toggle') + ' · ' + (sortDir === 'asc' ? t('sort.asc') : t('sort.desc')),
            'aria-label': t('sort.toggle'),
            onClick: onFlipDir,
          }, h(Icon, { name: sortDir === 'asc' ? 'arrowUp' : 'arrowDown', size: 13 })),
          h('button', {
            type: 'button', className: 'dsm-btn is-quiet', onClick: onRefresh, disabled: refreshing,
            title: t('action.refresh'),
          }, h(Icon, { name: 'refresh', size: 13 }), t('action.refresh'))))
    }

    function StatusPill({ t, summary, archived }) {
      if (summary.running) return h('span', { className: 'dsm-pill is-run' }, h('span', { className: 'd' }), t('status.running'))
      if (archived) return h('span', { className: 'dsm-pill is-arch' }, h('span', { className: 'd' }), t('status.archived'))
      return h('span', { className: 'dsm-pill is-ok' }, h('span', { className: 'd' }), t('status.normal'))
    }

    function Menu({ menu, t, onClose, onAction }) {
      const ref = useRef(null)
      useEffect(() => {
        if (menu === null) return undefined
        const onPointer = event => {
          if (ref.current !== null && ref.current.contains(event.target)) return
          onClose()
        }
        const onKey = event => { if (event.key === 'Escape') onClose() }
        document.addEventListener('mousedown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [menu, onClose])
      if (menu === null) return null
      const style = { left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 40 - menu.items.length * 31) }
      return h('div', { className: 'dsm-menu', ref, style, role: 'menu' },
        menu.items.map((item, index) => (item === '-'
          ? h('div', { className: 'dsm-menu-sep', key: 'sep' + index })
          : h('button', {
            key: item.id, type: 'button', role: 'menuitem',
            className: 'dsm-menu-item' + (item.danger ? ' is-danger' : ''),
            disabled: item.disabled === true,
            title: item.hint || undefined,
            onClick: () => { onClose(); onAction(item.id) },
          }, item.icon ? h(Icon, { name: item.icon, size: 14 }) : null, item.label))))
    }

    function Toast({ toast }) {
      if (toast === null) return null
      return h('div', { className: 'dsm-toast', role: 'status', 'aria-live': 'polite' }, toast)
    }

    /* ──────────────────────────── work handoff ──────────────────────── */

    /**
     * A one-slot handoff from the sidebar menu items to the page: the sidebar can
     * only hand over intent (an id), while the confirmation dialog and its state
     * live in the page component.
     */
    const pendingWork = { value: null, listeners: new Set() }

    function requestWork(work) {
      pendingWork.value = work
      for (const listener of pendingWork.listeners) listener(work)
    }

    /* ────────────────────────────── page ───────────────────────────── */

    /**
     * Column settings popover: drag to reorder, clear a box to hide.
     * Order and visibility are owned by the page and persisted by it.
     */
    function ColumnPanel({ t, columns, position, onChange, onReset, onDistribute, onClose }) {
      const ref = useRef(null)
      const [dragId, setDragId] = useState(null)
      const [overId, setOverId] = useState(null)
      useEffect(() => {
        const onPointer = event => { if (ref.current !== null && !ref.current.contains(event.target)) onClose() }
        const onKey = event => { if (event.key === 'Escape') onClose() }
        document.addEventListener('mousedown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [onClose])
      const move = (fromId, toId) => {
        if (fromId === toId || fromId === null) return
        onChange(previous => {
          const next = previous.slice()
          const from = next.findIndex(column => column.id === fromId)
          const to = next.findIndex(column => column.id === toId)
          if (from < 0 || to < 0) return previous
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return next
        })
      }
      return h('div', {
        className: 'dsm-cols', ref, role: 'dialog', 'aria-label': t('columns.title'),
        style: { left: Math.max(12, position.x), top: position.y },
      },
        h('div', { className: 'dsm-cols-head' }, t('columns.title'),
          h('button', { type: 'button', onClick: onReset }, t('columns.reset'))),
        columns.map(column => h('div', {
          key: column.id,
          className: 'dsm-cols-row' + (dragId === column.id ? ' is-drag' : '') + (overId === column.id ? ' is-over' : ''),
          draggable: true,
          onDragStart: event => { setDragId(column.id); event.dataTransfer.effectAllowed = 'move' },
          onDragOver: event => { event.preventDefault(); if (overId !== column.id) setOverId(column.id) },
          onDragLeave: () => setOverId(null),
          onDrop: event => { event.preventDefault(); setOverId(null); move(dragId, column.id); setDragId(null) },
          onDragEnd: () => { setDragId(null); setOverId(null) },
        },
          h('span', { className: 'dsm-cols-grip', title: t('columns.drag') }, h(Icon, { name: 'dots', size: 12 })),
          h('input', {
            type: 'checkbox',
            checked: column.visible,
            disabled: column.id === 'session' || column.id === 'actions',
            title: column.id === 'actions' ? t('columns.fixed') : undefined,
            onChange: event => {
              const visible = event.target.checked
              onChange(previous => previous.map(entry => (entry.id === column.id ? { ...entry, visible } : entry)))
            },
          }),
          h('span', { className: 'dsm-cols-label' }, t(column.label)))),
        h('div', { className: 'dsm-cols-hint' }, t('columns.hint')),
        h('div', { className: 'dsm-cols-foot' },
          h('button', {
            type: 'button',
            className: 'dsm-cols-action',
            title: t('columns.distributeHint'),
            onClick: onDistribute,
          }, h(Icon, { name: 'sort', size: 12 }), t('columns.distribute'))))
    }

    /**
     * Permanent-delete confirmation. Irreversible work gets an explicit
     * acknowledgement, and a large batch additionally needs its count typed.
     */
    function DeleteDialog({ t, target, ack, count, busy, onAck, onCount, onConfirm, onCancel }) {
      useEffect(() => {
        if (target === null) return undefined
        const onKey = event => { if (event.key === 'Escape') onCancel() }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [target, onCancel])
      if (target === null) return null
      const needsCount = target.length > 10
      const countOk = !needsCount || count.trim() === String(target.length)
      const canConfirm = ack && countOk && !busy
      return h('div', {
        className: 'dsm-scrim',
        onMouseDown: event => { if (event.target === event.currentTarget) onCancel() },
      },
        h('div', {
          className: 'dsm-dialog', role: 'dialog', 'aria-modal': 'true',
          'aria-label': t('delete.title', { n: target.length }),
        },
          h('h3', null,
            h(Icon, { name: 'trash', size: 16, style: { color: 'var(--dsw-alias-state-error-primary)' } }),
            t('delete.title', { n: target.length })),
          h('p', null, t('delete.body')),
          h('div', { className: 'dsm-dlist' },
            target.slice(0, 5).map(item => h('div', { className: 'dsm-dli', key: item.id },
              h(Icon, { name: 'chat', size: 12 }),
              h('span', { className: 'nm', title: item.title }, item.title),
              item.bytes !== null ? h('span', { className: 'sz' }, formatBytes(item.bytes)) : null)),
            target.length > 5 ? h('div', { className: 'dsm-dli' }, h('span', { className: 'nm' }, t('delete.more', { n: target.length - 5 }))) : null),
          h('div', { className: 'dsm-dwarn' },
            h(Icon, { name: 'warn', size: 13, style: { flex: 'none', marginTop: '2px' } }),
            h('span', null, t('delete.warn'))),
          needsCount
            ? h('input', {
              type: 'text', inputMode: 'numeric',
              placeholder: t('delete.count', { n: target.length }),
              value: count, onChange: event => onCount(event.target.value),
            })
            : null,
          h('label', { className: 'dsm-ack' },
            h('input', { type: 'checkbox', checked: ack, onChange: event => onAck(event.target.checked) }),
            t('delete.ack')),
          h('div', { className: 'dsm-dactions' },
            h('button', { type: 'button', className: 'dsm-btn', onClick: onCancel }, t('delete.cancel')),
            h('button', {
              type: 'button', className: 'dsm-btn is-solid-danger', disabled: !canConfirm, onClick: onConfirm,
            }, busy ? t('toast.deleteBusy') : t('delete.confirm')))))
    }

    function createPage(ctx, translate) {
      /**
       * Resolve a client service through the guarded lookup.
       * Cordis refuses `ctx.<service>` for a dependency the plugin did not
       * declare, so every service read goes through here — a missing service
       * then reports itself instead of surfacing a guard message.
       * @param name - Client service key.
       * @returns The service instance.
       */
      const service = name => {
        const optional = typeof ctx.get === 'function' ? ctx.get(name) : undefined
        if (optional !== undefined && optional !== null) return optional
        throw new Error('client service unavailable: ' + name)
      }

      return function SessionManagerPage(props) {
        // Use the framework's locale seat when present (it re-renders on a language
        // switch); otherwise the plugin-bound translator. Interpolation is ours
        // either way, because the seat returns the raw template.
        const t = (key, params) => {
          const text = typeof props.t === 'function' ? props.t(key) : translate(key)
          if (!params) return text
          let out = text
          for (const name of Object.keys(params)) out = out.split('{' + name + '}').join(String(params[name]))
          return out
        }
        const sessions = props.useSessions(state => state)
        const workspaces = props.useWorkspaces(state => state)

        const [query, setQuery] = useState('')
        const [status, setStatus] = useState('all')
        const [sortKey, setSortKey] = useState('updated')
        const [sortDir, setSortDir] = useState(SORT_DEFAULT_DIR.updated)
        const [range, setRange] = useState('all')
        const [sizeBand, setSizeBand] = useState('all')
        const [scope, setScope] = useState('all')
        const [includeHidden, setIncludeHidden] = useState(false)
        /**
         * Hidden workspaces are records, not ids: hiding unregisters the workspace
         * (that is what makes the native sidebar drop it), so the plugin has to
         * keep its path, title and session ids to be able to restore it.
         */
        const [hiddenRecords, setHiddenRecords] = useState(() => {
          const stored = readJson(LS_HIDDEN, [])
          return Array.isArray(stored) ? stored.filter(entry => entry && typeof entry.id === 'string') : []
        })
        const [expandedIds, setExpandedIds] = useState(() => {
          const stored = readJson(LS_EXPANDED, null)
          return new Set(Array.isArray(stored) ? stored : [])
        })
        const [selection, setSelection] = useState(() => new Set())
        const [menu, setMenu] = useState(null)
        const [toast, setToast] = useState(null)
        const [busy, setBusy] = useState(false)
        const [activeId, setActiveId] = useState(null)
        const [columns, setColumns] = useState(loadColumns)
        const [columnPanel, setColumnPanel] = useState(null)
        const [deleteTarget, setDeleteTarget] = useState(null)
        const [deleteAck, setDeleteAck] = useState(false)
        const [deleteCount, setDeleteCount] = useState('')
        const [deletedIds, setDeletedIds] = useState(() => new Set())
        const [now, setNow] = useState(() => Date.now())
        /** Read once, then kept in step: native controls (dropdown popups,
            scrollbars) and the light-scheme colours follow it. */
        const [colorScheme, setColorScheme] = useState(detectColorScheme)
        useEffect(() => {
          if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined
          const sync = () => setColorScheme(previous => {
            const next = detectColorScheme()
            return next === previous ? previous : next
          })
          const observer = new MutationObserver(sync)
          for (const target of [document.documentElement, document.body]) {
            if (!target) continue
            observer.observe(target, {
              attributes: true,
              attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-dsw-theme'],
            })
          }
          const media = typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-color-scheme: dark)')
            : null
          if (media !== null && typeof media.addEventListener === 'function') media.addEventListener('change', sync)
          return () => {
            observer.disconnect()
            if (media !== null && typeof media.removeEventListener === 'function') media.removeEventListener('change', sync)
          }
        }, [])

        const toastTimer = useRef(null)
        const listRef = useRef(null)
        const flashTimer = useRef(null)
        /** Last row the keyboard cursor sat on; outlives an uncheck, so ↑/↓
            never jump back to the top after cancelling a selection. */
        const cursorRef = useRef(null)
        const showToast = useCallback(message => {
          setToast(message)
          if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
          toastTimer.current = window.setTimeout(() => setToast(null), 2600)
        }, [])
        useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current) }, [])
        useEffect(() => {
          const timer = window.setInterval(() => setNow(Date.now()), 60000)
          return () => window.clearInterval(timer)
        }, [])

        // Per-session facts from the Host half: debounce a scan of the visible
        // session set so a busy list does not shoot one request per render.
        const [hostStats, setHostStats] = useState({})
        const statsIdsKey = useMemo(() => (Array.isArray(sessions.ids) ? sessions.ids.join(',') : ''), [sessions.ids])
        useEffect(() => {
          const ids = statsIdsKey === '' ? [] : statsIdsKey.split(',')
          if (ids.length === 0) { setHostStats(prev => (Object.keys(prev).length === 0 ? prev : {})); return undefined }
          let cancelled = false
          const timer = window.setTimeout(() => {
            requestStats(ids)
              .then(value => { if (!cancelled) setHostStats(value) })
              .catch(() => { /* the page degrades to "—" when the route is unavailable */ })
          }, 350)
          return () => { cancelled = true; window.clearTimeout(timer) }
        }, [statsIdsKey])

        const archivedSet = useMemo(
          () => new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []),
          [workspaces.archivedSessionIds])
        const hiddenSet = useMemo(() => new Set(hiddenRecords.map(record => record.id)), [hiddenRecords])

        /** Workspace groups in registry order plus the ungrouped bucket. */
        const groups = useMemo(() => {
          const items = Array.isArray(workspaces.items) ? workspaces.items : []
          const byId = sessions.byId || {}
          const assigned = new Set()
          const result = items.map(workspace => {
            const rows = (workspace.sessionIds || []).map(id => {
              assigned.add(id)
              return byId[id]
            }).filter(Boolean)
            return {
              key: workspace.workspaceId,
              path: workspace.path,
              title: workspace.title,
              label: workspaceLabel(workspace.path, workspace.title),
              hidden: hiddenSet.has(workspace.workspaceId),
              sessions: rows,
            }
          })
          const loose = (sessions.ids || []).filter(id => !assigned.has(id)).map(id => byId[id]).filter(Boolean)
          if (loose.length > 0) result.push({ key: '', path: '', title: t('tree.ungrouped'), label: t('tree.ungrouped'), hidden: false, sessions: loose })
          return result
        }, [workspaces.items, sessions.byId, sessions.ids, hiddenSet, t])

        const matchesQuery = useCallback(summary => {
          const needle = query.trim().toLowerCase()
          if (!needle) return true
          const fields = [summary.displayTitle, summary.title, summary.cwd, summary.id]
          return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(needle))
        }, [query])

        const keepSession = useCallback((summary, group) => {
          if (deletedIds.has(summary.id)) return false
          if (group.hidden && !includeHidden) return false
          const archived = archivedSet.has(summary.id)
          if (status === 'normal' && archived) return false
          if (status === 'archived' && !archived) return false
          return matchesQuery(summary)
        }, [archivedSet, deletedIds, includeHidden, matchesQuery, status])

        /** Host answer first, projection fallback; null when neither is ready. */
        const factsOf = useCallback(summary => {
          const host = hostStats[summary.id]
          if (host && typeof host === 'object') return host
          return statsOf(summary, sessions.projectionsBySession)
        }, [hostStats, sessions.projectionsBySession])

        const sizeOf = useCallback(summary => {
          const facts = factsOf(summary)
          return facts !== null && typeof facts.bytes === 'number' ? facts.bytes : null
        }, [factsOf])

        const createdOf = useCallback(summary => {
          const facts = factsOf(summary)
          return facts !== null && typeof facts.createdAt === 'number' ? facts.createdAt : null
        }, [factsOf])

        // Sidebar menu handoff: open the delete confirmation for the handed id.
        useEffect(() => {
          const accept = work => {
            if (work === null || work.kind !== 'delete') return
            const summary = sessions.byId ? sessions.byId[work.id] : undefined
            setDeleteTarget([{
              id: work.id,
              title: summary ? summary.displayTitle : work.id,
              bytes: summary ? sizeOf(summary) : null,
            }])
            setDeleteAck(false)
            setDeleteCount('')
          }
          pendingWork.listeners.add(accept)
          if (pendingWork.value !== null) {
            const work = pendingWork.value
            pendingWork.value = null
            accept(work)
          }
          return () => { pendingWork.listeners.delete(accept) }
        }, [sessions.byId, sizeOf])

        /** Time window and size band ride on top of the text and status filters. */
        const withinWindow = useCallback(summary => {
          if (range === 'all') return true
          const days = range === '7d' ? 7 : 30
          return typeof summary.updatedAt === 'number' && now - summary.updatedAt <= days * 86400000
        }, [now, range])

        const withinSizeBand = useCallback(summary => {
          if (sizeBand === 'all') return true
          const bytes = sizeOf(summary)
          if (typeof bytes !== 'number') return false
          const MB = 1024 * 1024
          if (sizeBand === 'small') return bytes < MB
          if (sizeBand === 'medium') return bytes <= 100 * MB
          return bytes > 100 * MB
        }, [sizeBand, sizeOf])

        /** The whole filter stack the list and the chip counts share. */
        const passesFilters = useCallback((summary, group) =>
          keepSession(summary, group) && withinWindow(summary) && withinSizeBand(summary),
          [keepSession, withinSizeBand, withinWindow])

        const sortRows = useCallback(rows => {
          const list = rows.slice()
          const key = sortKey
          const sign = sortDir === 'asc' ? 1 : -1
          // Rows are `{ summary, group }` wrappers: compare the summaries, or
          // every comparison reads `undefined` and the order never moves.
          list.sort((left, right) => {
            const a = left.summary
            const b = right.summary
            let diff
            if (key === 'title') diff = String(a.displayTitle || '').localeCompare(String(b.displayTitle || ''))
            else if (key === 'size') diff = (sizeOf(a) || 0) - (sizeOf(b) || 0)
            else if (key === 'created') diff = (createdOf(a) || a.updatedAt || 0) - (createdOf(b) || b.updatedAt || 0)
            else diff = (a.updatedAt || 0) - (b.updatedAt || 0)
            if (diff === 0) return 0
            return diff > 0 ? sign : -sign
          })
          return list
        }, [createdOf, sizeOf, sortDir, sortKey])

        /** Sessions visible in the list pane for the current scope. */
        const visible = useMemo(() => {
          const active = groups.filter(group => scope === 'all' || group.key === scope)
          const rows = []
          for (const group of active) {
            for (const summary of group.sessions) {
              if (passesFilters(summary, group)) rows.push({ summary, group })
            }
          }
          return sortRows(rows)
        }, [groups, passesFilters, scope, sortRows])

        const counts = useMemo(() => {
          let all = 0
          let archived = 0
          for (const group of groups) {
            if (group.hidden && !includeHidden) continue
            for (const summary of group.sessions) {
              if (!matchesQuery(summary)) continue
              if (!withinWindow(summary) || !withinSizeBand(summary)) continue
              all += 1
              if (archivedSet.has(summary.id)) archived += 1
            }
          }
          return { all, normal: all - archived, archived }
        }, [archivedSet, groups, includeHidden, matchesQuery, withinSizeBand, withinWindow])

        const totalBytes = useMemo(() => {
          let sum = 0
          let known = 0
          for (const group of groups) {
            if (group.hidden && !includeHidden) continue
            for (const summary of group.sessions) {
              const bytes = sizeOf(summary)
              if (typeof bytes === 'number') { sum += bytes; known += 1 }
            }
          }
          return known > 0 ? sum : null
        }, [groups, includeHidden, sizeOf])

        /** Header click: the same key flips direction, a new key starts at its default. */
        const sortColumn = useCallback(columnId => {
          const key = SORTABLE[columnId]
          if (key === undefined) return
          if (key === sortKey) {
            setSortDir(direction => (direction === 'asc' ? 'desc' : 'asc'))
            return
          }
          setSortKey(key)
          setSortDir(SORT_DEFAULT_DIR[key] || 'desc')
        }, [sortKey])

        /** Toolbar select: the chosen key decides the starting direction. */
        const pickSort = useCallback(key => {
          setSortKey(key)
          setSortDir(SORT_DEFAULT_DIR[key] || 'desc')
        }, [])

        const flipSort = useCallback(() => {
          setSortDir(direction => (direction === 'asc' ? 'desc' : 'asc'))
        }, [])

        /**
         * 刷新 re-measures instead of re-rendering: the Host answers from a 30s
         * cache unless the request asks it not to, so a chat that just grew
         * would otherwise keep reporting the size of its last scan.
         */
        const refreshNow = useCallback(async () => {
          const ids = Array.isArray(sessions.ids) ? sessions.ids : []
          setBusy(true)
          try {
            const value = ids.length === 0 ? {} : await requestStats(ids, { refresh: true })
            setHostStats(value)
            setNow(Date.now())
            showToast(t('toast.refreshed', { n: ids.length }))
          } catch (error) {
            showToast(t('toast.refreshFailed', { reason: (error && error.message) || String(error) }))
          } finally {
            setBusy(false)
          }
        }, [sessions.ids, showToast, t])

        const toggleExpanded = useCallback(key => {
          setExpandedIds(previous => {
            const next = new Set(previous)
            const isOpen = !previous.has(key)
            if (isOpen) next.add(key)
            else next.delete(key)
            writeJson(LS_EXPANDED, Array.from(next))
            return next
          })
        }, [])

        const setAllExpanded = useCallback(open => {
          const next = open ? new Set(groups.map(group => group.key)) : new Set()
          setExpandedIds(next)
          writeJson(LS_EXPANDED, Array.from(next))
        }, [groups])

        const hiddenWorkspaceIds = hiddenRecords.map(record => record.id)

        /** Persist the hidden records (they carry everything a restore needs). */
        const applyHiddenRecords = useCallback(records => {
          writeJson(LS_HIDDEN, records)
          setHiddenRecords(records)
        }, [])

        /**
         * Hide a workspace: the Host archives its sessions and unregisters it, so
         * it disappears from the native sidebar as well as from this page.
         */
        const hideWorkspace = useCallback(async group => {
          if (group.key === '') return
          try {
            const record = await requestHide(group.key)
            applyHiddenRecords([...hiddenRecords.filter(entry => entry.id !== record.id), record])
            if (scope === group.key) setScope('all')
            showToast(t('toast.hidden', { name: group.label }))
          } catch (error) {
            showToast((error && error.message) || String(error))
          }
        }, [applyHiddenRecords, hiddenRecords, scope, showToast, t])

        /** Re-register the workspace at its path and re-attach its sessions. */
        const restoreHidden = useCallback(async record => {
          try {
            await requestRestore(record)
            applyHiddenRecords(hiddenRecords.filter(entry => entry.id !== record.id))
            showToast(t('toast.restored', { name: record.title || record.path }))
          } catch (error) {
            showToast((error && error.message) || String(error))
          }
        }, [applyHiddenRecords, hiddenRecords, showToast, t])

        /** Run one mutation per id, sequentially, and report failures together. */
        const runEach = useCallback(async (ids, mutate) => {
          setBusy(true)
          let ok = 0
          let failed = 0
          let reason = ''
          for (const id of ids) {
            try {
              // Sequential on purpose: the workspace service rejects concurrent
              // registry writes for one domain.
              await mutate(id)
              ok += 1
            } catch (error) {
              failed += 1
              if (!reason) reason = (error && error.message) ? error.message : String(error)
            }
          }
          setBusy(false)
          return { ok, failed, reason }
        }, [])

        const archiveSessions = useCallback(async (ids) => {
          const result = await runEach(ids, id => service('workspaces').archiveSession(id))
          if (result.failed === 0) showToast(t('toast.archived', { n: result.ok }))
          else showToast(t('toast.failed', { n: result.failed, reason: result.reason }))
          setSelection(new Set())
        }, [ctx, runEach, showToast, t])

        const unarchiveSessions = useCallback(async (ids) => {
          const result = await runEach(ids, id => service('workspaces').unarchiveSession(id))
          if (result.failed === 0) showToast(t('toast.unarchived', { n: result.ok }))
          else showToast(t('toast.failed', { n: result.failed, reason: result.reason }))
          setSelection(new Set())
        }, [ctx, runEach, showToast, t])

        const openSession = useCallback(id => {
          try {
            service('uiWorkspace').openSession(id)
          } catch (error) {
            showToast((error && error.message) || String(error))
          }
        }, [ctx, showToast])

        const toggleSelection = useCallback(id => {
          setSelection(previous => {
            const next = new Set(previous)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }, [])

        /**
         * A click on a row toggles that row's check and nothing else: clicking
         * an already checked row unchecks it, and the focus ring leaves with
         * the check so the row really does look deselected again. Other checked
         * rows are untouched, which is what keeps a batch selection intact.
         * @param id - Session id.
         */
        const selectRow = useCallback(id => {
          cursorRef.current = id
          if (selection.has(id)) {
            setSelection(previous => {
              const next = new Set(previous)
              next.delete(id)
              return next
            })
            setActiveId(current => (current === id ? null : current))
            return
          }
          setSelection(previous => {
            if (previous.has(id)) return previous
            const next = new Set(previous)
            next.add(id)
            return next
          })
          setActiveId(id)
        }, [selection])

        /**
         * Arrow keys only move the cursor; checking stays an explicit act
         * (click or Space). Moving the check along with the cursor would fill
         * the batch selection just by walking down the list.
         * @param id - Session id to put the cursor on.
         */
        const moveCursor = useCallback(id => {
          cursorRef.current = id
          setActiveId(id)
        }, [])

        /** Row element lookup inside this pane only (never a global DOM query). */
        const rowElement = id => {
          const pane = listRef.current
          if (pane === null || typeof pane.querySelector !== 'function') return null
          return pane.querySelector('[data-sid="' + String(id).replace(/"/g, '') + '"]')
        }

        const scrollRowIntoView = useCallback(id => {
          const element = rowElement(id)
          if (element !== null && typeof element.scrollIntoView === 'function') {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
          }
        }, [])

        /** One-shot attention pulse; forcing a reflow lets it replay on a repeated locate. */
        const flashRow = useCallback(id => {
          const element = rowElement(id)
          if (element === null) return
          element.classList.remove('is-flash')
          void element.offsetWidth
          element.classList.add('is-flash')
          if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
          flashTimer.current = window.setTimeout(() => {
            element.classList.remove('is-flash')
            flashTimer.current = null
          }, 650)
        }, [])

        /**
         * A tree leaf focuses its row in the list instead of navigating away:
         * make sure it is part of the current view, scroll to it, pulse once.
         * @param summary - Session summary from the tree.
         * @param groupKey - Workspace id the leaf belongs to.
         */
        const locateSession = useCallback((summary, groupKey) => {
          if (scope !== 'all' && scope !== groupKey) setScope(groupKey)
          if (!matchesQuery(summary)) setQuery('')
          setActiveId(summary.id)
          window.setTimeout(() => {
            scrollRowIntoView(summary.id)
            flashRow(summary.id)
          }, 60)
        }, [flashRow, matchesQuery, scope, scrollRowIntoView])

        const pendingHint = t('pending.tooltip')

        const rowMenu = useCallback((event, summary, group) => {
          event.preventDefault()
          event.stopPropagation()
          const archived = archivedSet.has(summary.id)
          const items = [
            { id: 'open', label: t('row.open'), icon: 'open' },
            { id: 'refreshTitle', label: t('row.refreshTitle'), icon: 'pencil', disabled: true, hint: pendingHint },
            archived
              ? { id: 'unarchive', label: t('row.unarchive'), icon: 'unarchive' }
              : { id: 'archive', label: t('row.archive'), icon: 'archive' },
            '-',
            { id: 'delete', label: t('row.delete'), icon: 'trash', danger: true },
          ]
          setMenu({
            x: event.clientX, y: event.clientY, items,
            context: { kind: 'session', summary, group },
          })
        }, [archivedSet, pendingHint, t])

        const workspaceMenu = useCallback((event, group) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({
            x: event.clientX, y: event.clientY,
            items: group.key === ''
              ? [{ id: 'scope', label: t('tree.all'), icon: 'layers' }]
              : [
                { id: 'scope', label: t('tree.all'), icon: 'layers' },
                '-',
                { id: 'hideWorkspace', label: t('row.hideWorkspace'), icon: 'eyeOff' },
              ],
            context: { kind: 'workspace', group },
          })
        }, [t])

        const selectedIds = useMemo(() => visible.map(row => row.summary.id).filter(id => selection.has(id)), [selection, visible])
        const selectedBytes = useMemo(() => {
          let sum = 0
          let known = 0
          for (const row of visible) {
            if (!selection.has(row.summary.id)) continue
            const bytes = sizeOf(row.summary)
            if (typeof bytes === 'number') { sum += bytes; known += 1 }
          }
          return known > 0 ? sum : null
        }, [selection, sizeOf, visible])

        /**
         * Archived vs normal inside the current selection: the batch bar offers
         * only the action that applies, and both when the selection is mixed.
         */
        const selectionStats = useMemo(() => {
          let archived = 0
          let normal = 0
          for (const row of visible) {
            if (!selection.has(row.summary.id)) continue
            if (archivedSet.has(row.summary.id)) archived += 1
            else normal += 1
          }
          return { archived, normal }
        }, [archivedSet, selection, visible])

        const visibleColumns = useMemo(() => columns.filter(column => column.visible), [columns])
        /**
         * The flexible track is the visible column immediately left of the
         * actions column, so the leftover width lands inside a real column
         * instead of in an empty gutter: the last data column then ends where
         * 操作 begins and its centred content sits halfway between 大小 and 操作.
         * Derived from the live order, so hiding or dragging that column moves
         * the flex track with it.
         */
        const flexId = useMemo(() => {
          const index = visibleColumns.findIndex(column => column.id === 'actions')
          return index > 0 ? visibleColumns[index - 1].id : null
        }, [visibleColumns])
        /**
         * Every data column keeps its own pixel width; the flex column fills
         * whatever is left, which keeps the row flush with the pane and the
         * actions column against the right edge. Growing a column consumes that
         * leftover first; the drag handler borrows from the right neighbour once
         * it is gone, which is what keeps the last column inside the pane.
         */
        const gridTemplate = useMemo(() => {
          const tracks = [SELECT_WIDTH + 'px']
          for (const column of visibleColumns) {
            const width = Number.isFinite(column.width) ? Math.max(40, Math.round(column.width)) : 120
            tracks.push(column.id === flexId ? 'minmax(' + width + 'px, 1fr)' : width + 'px')
          }
          // Degenerate order (actions first, or alone): keep a trailing gutter
          // rather than leaving the table short of the pane.
          if (flexId === null) tracks.push('minmax(0, 1fr)')
          return tracks.join(' ')
        }, [flexId, visibleColumns])

        /** Any column change persists immediately, so the next visit restores it. */
        const updateColumns = useCallback(mutator => {
          setColumns(previous => {
            const next = mutator(previous)
            if (next !== previous) saveColumns(next)
            return next
          })
        }, [])

        /**
         * Give every visible column a width in proportion to its header label:
         * the longer the name, the wider the column. Each column keeps its own
         * floor, and the flex column absorbs whatever the floors added or took
         * away, so the table still ends exactly at the pane's edge.
         */
        const distributeColumns = useCallback(() => {
          const pane = listRef.current
          const paneWidth = pane === null ? 0 : pane.clientWidth
          const order = visibleColumns.map(column => column.id)
          const trackCount = 1 + order.length + (flexId === null ? 1 : 0)
          const available = Math.max(0, paneWidth - ROW_INSET - ROW_GAP * (trackCount - 1) - SELECT_WIDTH)
          const weights = visibleColumns.map(column => textWeight(translate(column.label)))
          const totalWeight = weights.reduce((total, weight) => total + weight, 0)
          if (paneWidth <= 0 || totalWeight <= 0) return
          const floors = visibleColumns.map(column => minWidthOf(column, translate))
          const widths = weights.map((weight, index) => Math.max(floors[index], Math.round(available * weight / totalWeight)))
          const flexIndex = visibleColumns.findIndex(column => column.id === flexId)
          if (flexIndex >= 0) {
            const overflow = widths.reduce((total, width) => total + width, 0) - available
            widths[flexIndex] = Math.max(floors[flexIndex], widths[flexIndex] - overflow)
          }
          updateColumns(previous => previous.map(column => {
            const index = order.indexOf(column.id)
            return index < 0 ? column : { ...column, width: widths[index] }
          }))
        }, [flexId, translate, updateColumns, visibleColumns])

        /**
         * Drag a column edge. Only the two columns that meet at that edge move:
         * the left one takes exactly what the right one gives up, so no third
         * column shifts. The flex column needs no bookkeeping (the layout hands
         * it whatever is left over), and the drag stops the moment the right
         * column reaches its own floor.
         */
        const startResize = useCallback((event, id) => {
          event.preventDefault()
          event.stopPropagation()
          const order = visibleColumns.map(column => column.id)
          const index = order.indexOf(id)
          if (index < 0) return
          const nextId = order[index + 1]
          // The actions column is a fixed rail and carries no handle.
          if (nextId === undefined || nextId === 'actions') return
          const owning = columns.find(column => column.id === id)
          const neighbour = columns.find(column => column.id === nextId)
          if (owning === undefined || neighbour === undefined) return

          const nextIsFlex = nextId === flexId
          const pane = listRef.current
          const paneWidth = pane === null ? 0 : pane.clientWidth
          const trackCount = 1 + order.length + (flexId === null ? 1 : 0)
          const available = Math.max(0, paneWidth - ROW_INSET - ROW_GAP * (trackCount - 1))
          const fixedSum = order.reduce((total, columnId) => {
            if (columnId === flexId) return total
            const column = columns.find(entry => entry.id === columnId)
            return total + (column === undefined ? 0 : Math.max(40, Math.round(column.width)))
          }, SELECT_WIDTH)

          const startX = event.clientX
          const startOwn = owning.width
          const minOwn = minWidthOf(owning, translate)
          const minNext = minWidthOf(neighbour, translate)
          // What the right column currently occupies on screen. The flex column
          // was saved with a floor, but the layout gave it the leftover width.
          const renderedNext = nextIsFlex
            ? Math.max(minNext, available - fixedSum)
            : neighbour.width
          const maxGrow = Math.max(0, renderedNext - minNext)

          const onMove = moveEvent => {
            const raw = moveEvent.clientX - startX
            const dx = Math.max(minOwn - startOwn, Math.min(raw, maxGrow))
            if (!Number.isFinite(dx)) return
            setColumns(previous => previous.map(column => {
              if (column.id === id) return { ...column, width: Math.round(startOwn + dx) }
              if (column.id === nextId && !nextIsFlex) {
                return { ...column, width: Math.round(neighbour.width - dx) }
              }
              return column
            }))
          }
          const onUp = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            setColumns(previous => { saveColumns(previous); return previous })
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
        }, [columns, flexId, translate, visibleColumns])

        /** Open the delete confirmation with the titles and sizes in hand. */
        const askDelete = useCallback(ids => {
          const wanted = new Set(ids)
          setDeleteTarget(visible
            .filter(row => wanted.has(row.summary.id))
            .map(row => ({ id: row.summary.id, title: row.summary.displayTitle, bytes: sizeOf(row.summary) })))
          setDeleteAck(false)
          setDeleteCount('')
        }, [sizeOf, visible])

        const confirmDelete = useCallback(async () => {
          const target = deleteTarget
          if (target === null || target.length === 0) return
          setBusy(true)
          try {
            const result = await requestDelete(target.map(item => item.id))
            if (result.deleted.length > 0) {
              setDeletedIds(previous => {
                const next = new Set(previous)
                for (const id of result.deleted) next.add(id)
                return next
              })
              showToast(t('toast.deleted', { n: result.deleted.length }))
            }
            if (result.failed.length > 0) {
              const first = result.failed[0]
              showToast(t('toast.deleteFailed', { n: result.failed.length, reason: first.message || first.code }))
            }
            setSelection(new Set())
            setDeleteTarget(null)
          } catch (error) {
            showToast((error && error.message) || String(error))
          } finally {
            setBusy(false)
          }
        }, [deleteTarget, showToast, t])

        /**
         * Menu dispatch. Declared after the mutation helpers so a first render
         * never reads them before initialization.
         * @param actionId - Chosen menu item id.
         */
        const onMenuAction = useCallback(actionId => {
          const current = menu
          if (current === null) return
          const { context } = current
          if (context.kind === 'session') {
            const { summary } = context
            if (actionId === 'open') openSession(summary.id)
            if (actionId === 'archive') archiveSessions([summary.id])
            if (actionId === 'unarchive') unarchiveSessions([summary.id])
            if (actionId === 'delete') askDelete([summary.id])
            return
          }
          const { group } = context
          if (actionId === 'scope') setScope(group.key)
          if (actionId === 'hideWorkspace') hideWorkspace(group)
        }, [archiveSessions, askDelete, hideWorkspace, menu, openSession, setScope, showToast, t, unarchiveSessions])

        const subtitle = totalBytes !== null
          ? t('page.subtitle', {
            workspaces: String(groups.filter(group => group.key !== '').length),
            sessions: String(groups.reduce((total, group) => total + group.sessions.length, 0)),
            size: formatBytes(totalBytes) || t('unknown'),
            archived: String(groups.reduce((total, group) => total + group.sessions.filter(s => archivedSet.has(s.id)).length, 0)),
          })
          : t('page.subtitleNoSize', {
            workspaces: String(groups.filter(group => group.key !== '').length),
            sessions: String(groups.reduce((total, group) => total + group.sessions.length, 0)),
            archived: String(groups.reduce((total, group) => total + group.sessions.filter(s => archivedSet.has(s.id)).length, 0)),
          })

        const listRows = visible

        /**
         * One body cell per configured column. Keys come from the column id, so a
         * reorder re-keys the row without remounting the whole list.
         * @param column - Column definition.
         * @param row - `{ summary, group }`.
         * @returns The cell element.
         */
        const cellFor = (column, row) => {
          const summary = row.summary
          const group = row.group
          const archived = archivedSet.has(summary.id)
          const created = createdOf(summary)
          const bytes = sizeOf(summary)
          switch (column.id) {
            case 'session':
              return h('div', { key: column.id, className: 'dsm-session' },
                h('span', { className: 'dsm-session-name', title: summary.displayTitle }, highlightHits(summary.displayTitle, query)),
                h('span', { className: 'dsm-session-meta' },
                  h('span', null, relativeTime(summary.updatedAt, now, t)),
                  h('span', null, '·'),
                  h('span', { className: 'dsm-mono' }, idPrefix(summary.id))))
            case 'workspace':
              return h('span', { key: column.id, className: 'dsm-ws-tag' + (group.hidden ? ' is-hidden' : '') },
                h(Icon, { name: group.hidden ? 'eyeOff' : 'folder', size: 12 }),
                h('span', { title: group.path || group.label }, highlightHits(group.label, query)))
            case 'created':
              return h('span', { key: column.id, className: 'dsm-cell' }, created !== null ? fmtAbs(created, t) : t('unknown'))
            case 'updated':
              return h('span', { key: column.id, className: 'dsm-cell' }, relativeTime(summary.updatedAt, now, t))
            case 'size': {
              // The total alone hides why it grew: say how much is logs and how
              // much is the projection cache, which is the part users can reclaim.
              const facts = factsOf(summary)
              const logBytes = facts !== null && typeof facts.logBytes === 'number' ? facts.logBytes : null
              const cacheBytes = facts !== null && typeof facts.cacheBytes === 'number' ? facts.cacheBytes : null
              const sizeTitle = logBytes === null
                ? undefined
                : cacheBytes === null || cacheBytes === 0
                  ? t('size.splitPartial', { log: formatBytes(logBytes) })
                  : t('size.split', { log: formatBytes(logBytes), cache: formatBytes(cacheBytes) })
              return h('span', { key: column.id, className: 'dsm-cell', title: sizeTitle },
                bytes !== null ? formatBytes(bytes) : t('unknown'))
            }
            case 'status':
              return h('span', { key: column.id }, h(StatusPill, { t, summary, archived }))
            case 'actions':
              return h('span', { key: column.id, className: 'dsm-actions' },
                h('button', {
                  type: 'button', className: 'dsm-ico-btn', title: t('row.open'),
                  onClick: () => openSession(summary.id),
                }, h(Icon, { name: 'open', size: 14 })),
                h('button', {
                  type: 'button', className: 'dsm-ico-btn',
                  title: archived ? t('row.unarchive') : t('row.archive'),
                  onClick: () => (archived ? unarchiveSessions([summary.id]) : archiveSessions([summary.id])),
                }, h(Icon, { name: archived ? 'unarchive' : 'archive', size: 14 })),
                h('button', {
                  type: 'button', className: 'dsm-ico-btn is-danger', title: t('row.delete'),
                  onClick: () => askDelete([summary.id]),
                }, h(Icon, { name: 'trash', size: 14 })))
            default:
              return h('span', { key: column.id })
          }
        }

        /** Gutter cell used only when no column can hold the flexible track. */
        const slackCell = h('span', { key: 'slack', 'aria-hidden': true })

        /**
         * Header cells in column order. A resize handle exists only where
         * dragging does something: the flex column ends at 操作 and the actions
         * column ends at the pane edge, so neither ships a dead handle.
         */
        const headerCells = []
        visibleColumns.forEach((column, index) => {
          const next = visibleColumns[index + 1]
          const resizable = next !== undefined && next.id !== 'actions'
          // Sortable columns carry the sort in the header itself; the hint names
          // the direction a click lands in, so the control is never a surprise.
          const sortKeyFor = SORTABLE[column.id]
          const sorted = sortKeyFor !== undefined && sortKeyFor === sortKey
          const direction = sorted ? sortDir : (SORT_DEFAULT_DIR[sortKeyFor] || 'desc')
          const label = sortKeyFor === undefined
            ? h('span', null, t(column.label))
            : h('button', {
              type: 'button',
              className: 'dsm-th-sort' + (sorted ? ' is-on' : ''),
              title: t('sort.hint', { label: t(column.label) }) + ' · ' + (direction === 'asc' ? t('sort.asc') : t('sort.desc')),
              onClick: () => sortColumn(column.id),
            },
              h('span', null, t(column.label)),
              sorted ? h('span', { className: 'dsm-th-dir' },
                h(Icon, { name: sortDir === 'asc' ? 'arrowUp' : 'arrowDown', size: 10 })) : null)
          headerCells.push(h('div', {
            key: column.id,
            className: 'dsm-th'
              + (column.id === 'actions' ? ' is-actions' : '')
              + (column.id === flexId ? ' is-flex' : ''),
          },
            label,
            resizable ? h('button', {
              type: 'button',
              className: 'dsm-resizer',
              tabIndex: -1,
              'aria-label': t(column.label),
              onPointerDown: event => startResize(event, column.id),
            }) : null))
        })
        if (flexId === null) headerCells.push(slackCell)

        /**
         * Body cells in the same order as the header, so the grid tracks line up.
         * @param row - `{ summary, group }`.
         * @returns Keyed cell elements.
         */
        const rowCells = row => {
          const cells = visibleColumns.map(column => cellFor(column, row))
          if (flexId === null) cells.push(slackCell)
          return cells
        }

        /**
         * Keyboard model: arrows move the cursor only, Space toggles that row's
         * check, Enter opens it. With no cursor (first visit, or just after an
         * uncheck) the remembered row seeds the step, so ↑/↓ carries on from
         * where the user was instead of restarting at the top of the list.
         */
        const onListKeyDown = useCallback(event => {
          if (listRows.length === 0) return
          let index = listRows.findIndex(row => row.summary.id === activeId)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            if (index < 0) index = listRows.findIndex(row => row.summary.id === cursorRef.current)
            const nextIndex = Math.max(0, Math.min(listRows.length - 1, index + step))
            const nextId = listRows[nextIndex].summary.id
            moveCursor(nextId)
            scrollRowIntoView(nextId)
            return
          }
          if (index < 0) return
          const current = listRows[index].summary
          if (event.key === 'Enter') {
            event.preventDefault()
            openSession(current.id)
          }
          if (event.key === ' ') {
            event.preventDefault()
            toggleSelection(current.id)
          }
        }, [activeId, listRows, moveCursor, openSession, scrollRowIntoView, toggleSelection])
        const isFiltered = status !== 'all' || query.trim() !== '' || includeHidden || range !== 'all' || sizeBand !== 'all'

        return h('div', { className: 'dsm-page', 'data-dsh-panel': PANEL_ID, 'data-scheme': colorScheme, style: { colorScheme } },

          // ── header
          h('header', { className: 'dsm-head' },
            h('div', { className: 'dsm-title' },
              h('h1', null, t('page.title')),
              h('p', { className: 'dsm-sub' }, subtitle)),
            h('div', { className: 'dsm-head-actions' },
              h('div', { className: 'dsm-search' },
                h(Icon, { name: 'search', size: 14 }),
                h('input', {
                  value: query,
                  placeholder: t('search.placeholder'),
                  onChange: event => setQuery(event.target.value),
                  spellCheck: false,
                }),
                query !== '' ? h('button', { type: 'button', onClick: () => setQuery(''), title: t('search.clear') }, h(Icon, { name: 'close', size: 12 })) : null),
              h('button', {
                type: 'button', className: 'dsm-btn is-quiet', title: t('columns.title'),
                onClick: event => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setColumnPanel(panel => (panel === null ? { x: rect.right - 250, y: rect.bottom + 6 } : null))
                },
              }, h(Icon, { name: 'layers', size: 13 }), t('columns.title')))),

          // ── filter bar
          h(Toolbar, {
            t, status, onStatus: setStatus, counts,
            sortKey, onSort: pickSort, sortDir, onFlipDir: flipSort,
            includeHidden, onIncludeHidden: value => setIncludeHidden(value),
            range, onRange: setRange, sizeBand, onSizeBand: setSizeBand,
            onRefresh: refreshNow, refreshing: busy,
          }),

          // ── body
          h('div', { className: 'dsm-body' },
            h('section', { className: 'dsm-tree', 'aria-label': t('tree.header') },
              h('div', { className: 'dsm-tree-head' }, t('tree.header'),
                h('span', { className: 'sp' },
                  h('button', { type: 'button', onClick: () => setAllExpanded(false) }, t('action.collapseAll')),
                  h('button', { type: 'button', onClick: () => setAllExpanded(true) }, t('action.expandAll')))),
              h('button', {
                type: 'button',
                className: 'dsm-node' + (scope === 'all' ? ' is-sel' : ''),
                onClick: () => setScope('all'),
              },
                h('span', { className: 'dsm-caret' }),
                h('span', { className: 'dsm-node-ico' }, h(Icon, { name: 'layers', size: 14 })),
                h('span', { className: 'dsm-node-label' }, t('tree.all')),
                h('span', { className: 'dsm-node-agg' }, totalBytes !== null ? h('span', null, formatBytes(totalBytes)) : null)),
              groups.filter(group => group.key !== '' && (!group.hidden || includeHidden)).map(group => {
                const open = expandedIds.has(group.key)
                const bytes = group.sessions.reduce((total, summary) => total + (sizeOf(summary) || 0), 0)
                const known = group.sessions.some(summary => typeof sizeOf(summary) === 'number')
                return h('div', { key: group.key + ':wrap' },
                  h('button', {
                    type: 'button',
                    className: 'dsm-node' + (scope === group.key ? ' is-sel' : '') + (group.hidden ? ' is-hidden' : ''),
                    onClick: () => setScope(group.key),
                    onContextMenu: event => workspaceMenu(event, group),
                  },
                    h('span', {
                      className: 'dsm-caret' + (open ? ' is-open' : ''),
                      onClick: event => { event.stopPropagation(); toggleExpanded(group.key) },
                    }, h(Icon, { name: 'chev', size: 11 })),
                    h('span', { className: 'dsm-node-ico' }, h(Icon, { name: group.hidden ? 'eyeOff' : 'folder', size: 14 })),
                    h('span', { className: 'dsm-node-label', title: group.path || group.label }, group.path || group.label),
                    h('span', { className: 'dsm-node-agg' },
                      known ? h('span', null, formatBytes(bytes)) : null)),
                  open ? h('div', { className: 'dsm-children' }, group.sessions.slice(0, 40).map(summary => h('button', {
                    key: summary.id, type: 'button', className: 'dsm-leaf',
                    // One click locates the row in the list; double-click jumps
                    // to the conversation (the list itself no longer does).
                    title: summary.displayTitle + ' · ' + t('row.openHint'),
                    onClick: () => locateSession(summary, group.key),
                    onDoubleClick: () => openSession(summary.id),
                  },
                    h('span', { className: 'dsm-dot' + (archivedSet.has(summary.id) ? ' is-arch' : summary.running ? ' is-run' : '') }),
                    h('span', { className: 'dsm-leaf-label' }, summary.displayTitle),
                    h('span', { className: 'dsm-leaf-size' }, formatBytes(sizeOf(summary)) || '')))) : null)
              }),
              hiddenRecords.length > 0
                ? h('div', null,
                  h('div', { className: 'dsm-tree-sub' },
                    t('tree.hiddenGroup'), h('span', { className: 'n' }, String(hiddenRecords.length)),
                    h('span', { className: 'sp' },
                      h('button', {
                        type: 'button',
                        onClick: () => { for (const record of hiddenRecords) restoreHidden(record) },
                      }, t('tree.restore')))),
                  hiddenRecords.map(record => h('div', { key: record.id, className: 'dsm-node is-hidden' },
                    h('span', { className: 'dsm-caret' }),
                    h('span', { className: 'dsm-node-ico' }, h(Icon, { name: 'eyeOff', size: 14 })),
                    h('span', { className: 'dsm-node-label', title: record.path }, record.path || record.title),
                    h('span', { className: 'dsm-node-agg' },
                      h('button', {
                        type: 'button',
                        style: {
                          border: 0, background: 'none', font: 'inherit', fontSize: '11.5px',
                          color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
                        },
                        onClick: () => restoreHidden(record),
                      }, t('row.restoreWorkspace'))))))
                : null),

            h('section', { className: 'dsm-list', 'aria-label': t('page.title'), ref: listRef },
              // The header lives inside the scroll container: it sticks to the top
              // and shares the rows' exact width, so a scrollbar can no longer
              // shift every column relative to its heading.
              h('div', { className: 'dsm-rows', tabIndex: 0, onKeyDown: onListKeyDown },
                h('div', { className: 'dsm-thead', style: { gridTemplateColumns: gridTemplate } },
                  h('button', {
                    type: 'button',
                    className: 'dsm-cbx' + (listRows.length > 0 && selectedIds.length === listRows.length ? ' is-on' : ''),
                    'aria-label': t('batch.selected', { n: selectedIds.length }),
                    onClick: () => setSelection(previous => {
                      const allSelected = listRows.length > 0 && listRows.every(row => previous.has(row.summary.id))
                      return allSelected ? new Set() : new Set(listRows.map(row => row.summary.id))
                    }),
                  }),
                  visibleColumns.length > 0 ? headerCells : null),

                listRows.length === 0
                  ? h('div', { className: 'dsm-empty' },
                    h('div', { className: 'h' }, isFiltered ? t('empty.filtered') : t('empty.none')),
                    h('div', null, isFiltered ? t('empty.filteredHint') : t('empty.noneHint')),
                    isFiltered ? h('button', {
                      type: 'button', className: 'dsm-btn', style: { marginTop: '6px' },
                      onClick: () => {
                        setQuery('')
                        setStatus('all')
                        setIncludeHidden(false)
                        setRange('all')
                        setSizeBand('all')
                      },
                    }, t('empty.clearFilters')) : null)
                  : listRows.map(({ summary, group }) => {
                    const checked = selection.has(summary.id)
                    const active = activeId === summary.id
                    return h('div', {
                      key: summary.id,
                      'data-sid': summary.id,
                      className: 'dsm-row' + (checked ? ' is-checked' : '') + (active ? ' is-active' : ''),
                      style: { gridTemplateColumns: gridTemplate },
                      // A click toggles this row's check. Opening is deliberate:
                      // the open button, or Enter for keyboard users.
                      onClick: () => selectRow(summary.id),
                      onContextMenu: event => rowMenu(event, summary, group),
                    },
                      h('button', {
                        type: 'button',
                        className: 'dsm-cbx' + (checked ? ' is-on' : ''),
                        'aria-label': summary.displayTitle,
                        onClick: event => { event.stopPropagation(); toggleSelection(summary.id) },
                      }),
                      rowCells({ summary, group }))
                  })),

              selectedIds.length > 0
                ? h('div', { className: 'dsm-batch' },
                  h('span', { className: 'n' }, t('batch.selected', { n: selectedIds.length }), selectedBytes !== null ? ' · ' + formatBytes(selectedBytes) : ''),
                  h('span', { className: 'dsm-divider' }),
                  // Only the action that applies to the selection is offered; a mixed
                  // selection gets both, and each acts on its own subset.
                  selectionStats.normal > 0
                    ? h('button', {
                      type: 'button', className: 'dsm-btn', disabled: busy,
                      onClick: () => archiveSessions(selectedIds.filter(id => !archivedSet.has(id))),
                    }, h(Icon, { name: 'archive', size: 13 }), t('batch.archive'))
                    : null,
                  selectionStats.archived > 0
                    ? h('button', {
                      type: 'button', className: 'dsm-btn', disabled: busy,
                      onClick: () => unarchiveSessions(selectedIds.filter(id => archivedSet.has(id))),
                    }, h(Icon, { name: 'unarchive', size: 13 }), t('batch.unarchive'))
                    : null,
                  h('button', {
                    type: 'button', className: 'dsm-btn is-danger', disabled: busy,
                    onClick: () => askDelete(selectedIds),
                  }, h(Icon, { name: 'trash', size: 13 }), t('row.delete')),
                  h('span', { className: 'sp' },
                    h('button', { type: 'button', className: 'dsm-btn is-quiet', onClick: () => setSelection(new Set()) }, t('batch.clear'))))
                : null,

              h('div', { className: 'dsm-foot' },
                h('span', null, t('footnote', { shown: String(listRows.length), total: String(counts.all) })),
                totalBytes === null ? h('span', null, t('footnote.sizeUnknown')) : null))),

          h(Menu, { menu, t, onClose: () => setMenu(null), onAction: onMenuAction }),
          columnPanel !== null
            ? h(ColumnPanel, {
              t,
              columns,
              position: columnPanel,
              onChange: updateColumns,
              onReset: () => updateColumns(() => DEFAULT_COLUMNS.map(column => ({ ...column }))),
              onDistribute: distributeColumns,
              onClose: () => setColumnPanel(null),
            })
            : null,
          h(DeleteDialog, {
            t,
            target: deleteTarget,
            ack: deleteAck,
            count: deleteCount,
            busy,
            onAck: setDeleteAck,
            onCount: setDeleteCount,
            onConfirm: confirmDelete,
            onCancel: () => setDeleteTarget(null),
          }),
          h(Toast, { toast }))
      }
    }

    /* ───────────────────────────── plugin ──────────────────────────── */

    /**
     * Insert this plugin's stylesheet, reusing one tag across module reloads.
     * @returns Disposer removing the tag it owns.
     */
    function insertStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-dsh-plugin-css="' + STYLE_KEY + '"]')
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.dshPlugin = 'dsh-session-manager'
      tag.dataset.dshPluginCss = STYLE_KEY
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /** Sidebar row glyph: inherits the row colour, never picks its own. */
    function SessionManagerIcon(props) {
      const edge = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 20 20',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.25,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false', style: { display: 'block' },
      },
        h('path', { d: 'M5.5 3.1H14.5A3 3 0 0 1 17.5 6.1V10.1A3 3 0 0 1 14.5 13.1H10.6L7.4 15.9V13.1H5.5A3 3 0 0 1 2.5 10.1V6.1A3 3 0 0 1 5.5 3.1Z' }),
        h('path', { d: 'M6.4 6.6H13.6' }),
        h('path', { d: 'M6.4 9.9H11.2' }))
    }

    return {
      name: 'dsh-session-manager',
      // Hard client dependencies: the page archives sessions and opens them.
      // Cordis refuses `ctx.<service>` for a dependency this list omits.
      inject: ['slots', 'locale', 'workspaces', 'uiWorkspace'],

      apply(ctx) {
        for (const locale of Object.keys(DICTIONARIES)) {
          ctx.effect(() => ctx.locale.register(NS, locale, DICTIONARIES[locale]), 'dsh-session-manager: ' + locale + ' dictionary')
        }
        ctx.effect(insertStyles, 'dsh-session-manager: stylesheet')

        // Interpolation helper over the plugin's own namespace; reading the active
        // locale at call time keeps the page following a language switch.
        const bind = ctx.locale.bind(NS)
        const translate = (key, params) => {
          let text = bind(key)
          if (params) {
            for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]))
          }
          return text
        }

        /** Read the row label at projection time so locale switches need no re-registration. */
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => t('tab.title'),
          locale: NS,
        }, SessionManagerIcon))

        const Page = createPage(ctx, translate)
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Page))

        // A red trash for the sidebar's delete item: the menu row is `danger`, so
        // this icon inherits the error colour through currentColor — never a hex.
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: 'dsh-session-manager.trash',
        }, () => h(Icon, { name: 'trash', size: 16 })))

        // ── sidebar context-menu additions (design: preview-states.png ①②) ──
        // Both services are read through the optional lookup on purpose: they are
        // enhancements, and a missing one must not deactivate the whole plugin.
        const contextMenus = typeof ctx.get === 'function' ? ctx.get('contextMenus') : undefined
        const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
        const openPanel = () => {
          if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        }
        const rememberHidden = record => {
          const stored = readJson(LS_HIDDEN, [])
          const list = Array.isArray(stored) ? stored.filter(entry => entry && entry.id !== record.id) : []
          list.push(record)
          writeJson(LS_HIDDEN, list)
        }
        if (contextMenus !== undefined && typeof contextMenus.register === 'function') {
          ctx.effect(() => contextMenus.register({
            id: 'dsh-session-manager.session.delete',
            target: 'session',
            order: 700,
            resolve: target => {
              const id = target && (target.sessionId || (target.value && target.value.sessionId))
              if (typeof id !== 'string') return []
              return [{
                id: 'session-manager.delete',
                label: translate('row.delete'),
                danger: true,
                icon: { key: 'dsh-session-manager.trash' },
                separatorBefore: true,
                run: () => {
                  // Hand the target to the page, then open the page so the
                  // confirmation happens in the same place as a batch delete.
                  requestWork({ kind: 'delete', id })
                  openPanel()
                },
              }]
            },
          }), 'dsh-session-manager: session menu item')
          ctx.effect(() => contextMenus.register({
            id: 'dsh-session-manager.workspace.hide',
            target: 'workspace',
            order: 250,
            resolve: target => {
              const id = target && (target.workspaceId || (target.value && target.value.workspaceId))
              if (typeof id !== 'string') return []
              return [{
                id: 'session-manager.hide',
                label: translate('row.hideWorkspace'),
                run: async () => {
                  try {
                    rememberHidden(await requestHide(id))
                  } catch (error) {
                    console.error('[dsh-session-manager] hide workspace failed', error)
                  }
                },
              }]
            },
          }), 'dsh-session-manager: workspace menu item')
        }
      },
    }
  },
})
