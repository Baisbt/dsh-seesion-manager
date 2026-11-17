/**
 * Host half of dsh-session-manager.
 *
 * The page's browser half can read titles, ids, workspace membership and archive
 * state from the client services, but two facts only exist on the host: a
 * session's created time and how much disk it occupies. This half computes them
 * and serves them over one authenticated route on the `connection` channel —
 * the same mechanism dsh-context uses (`connection.fetch.register`) — with a
 * plain JSON envelope:
 *
 *     POST /api/dsh-session-manager/stats   { ids: string[] }
 *     200  { ok: true, value: { [id]: { createdAt, bytes, logBytes, cacheBytes, dir, live } } }
 *     500  { ok: false, error: { code, message } }
 *
 * Size policy (the user asked for it): `bytes` = the whole session directory
 * (every retained log generation) **plus** that session's projection-cache
 * documents under `storages/session_projcache/sessions/`. `logBytes` and
 * `cacheBytes` are reported separately so the page can explain the split.
 *
 * `live` marks a session this process still holds open. It is answered fresh on
 * every request: the page disables its delete action for those rows instead of
 * letting the user run into the refusal.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-session-manager'

/** Both services are hard dependencies: the routes are useless without them. */
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry', 'sessions']

/** Per-session facts for the page's list. */
const STATS_PATH = '/api/dsh-session-manager/stats'
/** Permanent deletion. */
const DELETE_PATH = '/api/dsh-session-manager/delete'
/** Unregister a workspace so the native sidebar stops listing it. */
const HIDE_PATH = '/api/dsh-session-manager/hide'
/** Put a hidden workspace back together with its sessions. */
const RESTORE_PATH = '/api/dsh-session-manager/restore'
/** Bound the work one request can trigger. */
const MAX_IDS = 500
/** Concurrent filesystem walks. */
const CONCURRENCY = 4
/** Reuse a session's numbers for this long before rescanning. */
const CACHE_TTL_MS = 30000

/** @type {Map<string, { at: number, value: object }>} */
const cache = new Map()

/**
 * Resolve the DSH home directory. The profile directory is
 * `<home>/profiles/<name>`, so its grandparent is the home; environment
 * fallbacks keep the plugin usable in other launch layouts.
 * @returns Absolute DSH home path.
 */
function dshHome() {
  const profile = process.env.DSH_PROFILE_DIR
  if (typeof profile === 'string' && profile.length > 0) return dirname(dirname(profile))
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return home
  return join(homedir(), '.dsh')
}

/**
 * Sum the bytes of every file below a directory.
 * @param dir - Absolute directory path.
 * @returns Total size in bytes; 0 when the directory is unreadable.
 */
async function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(path)
      continue
    }
    try {
      total += (await stat(path)).size
    } catch {
      // A file that vanished mid-walk simply contributes nothing.
    }
  }
  return total
}

/**
 * Every projection-cache document that belongs to one session (current + backups).
 * @param id - Session id.
 * @returns Absolute file paths.
 */
async function projectionCacheFiles(id) {
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name !== id + '.json' && !entry.name.startsWith(id + '.json.')) continue
    files.push(join(dir, entry.name))
  }
  return files
}

/**
 * Size of one session's projection-cache documents.
 * @param id - Session id.
 * @returns Total size in bytes.
 */
async function projectionCacheSize(id) {
  let total = 0
  for (const file of await projectionCacheFiles(id)) {
    try {
      total += (await stat(file)).size
    } catch {
      // Ignore a concurrently removed document.
    }
  }
  return total
}

/**
 * Collect one session's facts.
 *
 * `live` is answered on every call instead of being cached with the numbers: a
 * session enters and leaves the live store as the window opens and closes it,
 * and the page uses this flag to tell the user why a delete will be refused.
 *
 * @param ctx - Host context.
 * @param id - Session id.
 * @param refresh - When true the cached numbers are ignored and re-measured.
 * @returns `{ createdAt, bytes, logBytes, cacheBytes, dir, live }`.
 */
async function sessionFacts(ctx, id, refresh = false) {
  /** Whether this process still holds the session (open conversation or a
      running agent). Deleting its files underneath that writer cannot work. */
  const live = ctx.sessions.get(id) !== undefined
  const cached = cache.get(id)
  if (refresh !== true && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.value, live }
  }

  const snapshot = await ctx.sessionPersistence.stat(id)
  const createdAt = snapshot?.header?.createdAt ?? null
  const location = snapshot?.location
  const dir = typeof location?.path === 'string' ? dirname(location.path) : null
  const logBytes = typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : 0
  const dirBytes = dir === null ? logBytes : await directorySize(dir)
  const cacheBytes = await projectionCacheSize(id)
  const value = {
    createdAt: typeof createdAt === 'number' ? createdAt : null,
    bytes: (dir === null ? logBytes : dirBytes) + cacheBytes,
    logBytes: dirBytes,
    cacheBytes,
    dir,
  }
  cache.set(id, { at: Date.now(), value })
  return { ...value, live }
}

/**
 * Run tasks with a fixed concurrency ceiling.
 * @param items - Input list.
 * @param limit - Maximum in-flight tasks.
 * @param worker - Async worker.
 * @returns One result per input, in order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Build a JSON response with the envelope the browser half expects.
 * @param status - HTTP status.
 * @param payload - Envelope body.
 * @returns The response.
 */
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Delete one session permanently: its log directory, its projection-cache
 * documents, and (best effort) every registry reference to its id.
 *
 * DSH has no session-delete API, so this is the plugin's own implementation.
 * It refuses a session that is currently attached to this process — deleting
 * under a live writer would corrupt the log — and refuses any directory outside
 * `<dsh home>/sessions`.
 *
 * @param ctx - Host context.
 * @param id - Session id.
 * @returns `{ id, ok }` plus the failure reason when it did not delete.
 */
async function deleteSession(ctx, id) {
  if (ctx.sessions.get(id) !== undefined) {
    // DSH has no "close session" action: once a window has opened a session its
    // agent (and the open log writer) lives until this process exits. The log is
    // also locked, so removing it would fail or corrupt it — refuse and let the
    // page explain that a restart is the way in.
    return { id, ok: false, code: 'session-live', message: 'session is still open in this process; restart DSH to delete it' }
  }
  let snapshot
  try {
    snapshot = await ctx.sessionPersistence.stat(id)
  } catch (error) {
    return { id, ok: false, code: 'stat-failed', message: String(error?.message ?? error) }
  }
  const path = snapshot?.location?.path
  if (typeof path !== 'string') {
    return { id, ok: false, code: 'no-log', message: 'no materialized log file was found for this session' }
  }
  const dir = resolve(dirname(path))
  const root = resolve(join(dshHome(), 'sessions'))
  if (dir !== root && !dir.startsWith(root + sep)) {
    return { id, ok: false, code: 'outside-root', message: 'refusing to delete a directory outside the sessions root' }
  }
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    return { id, ok: false, code: 'delete-failed', message: String(error?.message ?? error) }
  }
  for (const file of await projectionCacheFiles(id)) {
    try { await rm(file, { force: true }) } catch { /* best effort */ }
  }
  // Registry references: an id left behind would keep a phantom row alive in the
  // sidebar's grouping even though the log is gone.
  for (const cleanup of [
    () => ctx.workspaceRegistry.unarchiveSession(id),
    () => ctx.workspaceRegistry.unpinSession(id),
    async () => {
      const owner = ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(id))
      if (owner !== undefined) await owner.detachSession(id)
    },
  ]) {
    try { await cleanup() } catch { /* nothing to clean */ }
  }
  cache.delete(id)
  return { id, ok: true, dir }
}

/**
 * Hide one workspace: archive its sessions, then remove its registration.
 *
 * DSH has no workspace visibility flag, and the sidebar browser reads the
 * registry directly, so the only way a workspace stops showing up there is to
 * stop being registered. Archiving its sessions first keeps the sidebar from
 * listing them under "Ungrouped" once the group is gone. The caller stores the
 * returned record, which is everything `restoreWorkspace` needs.
 *
 * @param ctx - Host context.
 * @param id - Workspace id.
 * @returns `{ ok: true, record }` or a failure reason.
 */
async function hideWorkspace(ctx, id) {
  const workspace = ctx.workspaceRegistry.get(id)
  if (workspace === undefined) {
    return { ok: false, code: 'not-found', message: 'workspace not found' }
  }
  const record = {
    id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    archived: 0,
    skipped: 0,
  }
  for (const sessionId of record.sessionIds) {
    try {
      await ctx.workspaceRegistry.archiveSession(sessionId)
      record.archived += 1
    } catch {
      // A running session refuses archival; it stays visible rather than lost.
      record.skipped += 1
    }
  }
  const removed = await ctx.workspaceRegistry.delete(id)
  if (!removed) return { ok: false, code: 'delete-failed', message: 'workspace registration was not removed' }
  return { ok: true, record }
}

/**
 * Restore a hidden workspace: re-register it at its path, re-attach its sessions
 * and clear their archive state.
 *
 * A hidden record can outlive the workspace's absence: the user may have added
 * the same directory again in the meantime. `create` already resolves by
 * canonical path and would silently return that new workspace, which turns a
 * "restore" into a merge the caller never agreed to — so the merge is answered
 * separately and has to be confirmed first.
 *
 * @param ctx - Host context.
 * @param request - The record `hideWorkspace` returned.
 * @param confirmMerge - When true, an existing workspace at that path is reused
 *   and the recorded sessions are attached to it.
 * @returns `{ needsConfirm, workspace, candidates }` when a confirmation is
 *   required, otherwise `{ id, title, attached, merged }`.
 */
async function restoreWorkspace(ctx, request, confirmMerge = false) {
  if (typeof request.path !== 'string' || request.path.length === 0) {
    return { ok: false, code: 'bad-record', message: 'the stored record has no path' }
  }
  const sessionIds = (Array.isArray(request.sessionIds) ? request.sessionIds : [])
    .filter(id => typeof id === 'string' && id.length > 0)
  /** A workspace may already own this directory; a missing path throws and is
      left to `create` so the caller gets the Host's own reason. */
  let existing
  try {
    existing = await ctx.workspaceRegistry.resolveByPath(request.path)
  } catch {
    existing = undefined
  }
  if (existing !== undefined && confirmMerge !== true) {
    return {
      ok: true,
      value: {
        needsConfirm: true,
        workspace: { id: existing.id, path: existing.path, title: existing.title },
        candidates: sessionIds.length,
      },
    }
  }
  const workspace = existing !== undefined
    ? existing
    : await ctx.workspaceRegistry.create(request.path, typeof request.title === 'string' ? request.title : undefined)
  let attached = 0
  for (const sessionId of sessionIds) {
    try {
      await workspace.attachSession(sessionId)
      attached += 1
    } catch {
      // cwd no longer matches the path, or the log is gone: leave it ungrouped.
    }
    try {
      await ctx.workspaceRegistry.unarchiveSession(sessionId)
    } catch {
      // Already normal.
    }
  }
  return {
    ok: true,
    value: {
      id: workspace.id,
      title: workspace.title,
      attached,
      merged: existing !== undefined,
      total: sessionIds.length,
    },
  }
}

/**
 * Register the page's two routes.
 * @param ctx - Host context carrying `connection`, `sessionPersistence` and `workspaceRegistry`.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: STATS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        let ids = []
        /** `refresh: true` is what the page's 刷新 button sends: measure again
            instead of answering from the numbers cached on the previous scan. */
        let refresh = false
        try {
          const body = await request.json()
          const raw = body && Array.isArray(body.ids) ? body.ids : []
          ids = raw.filter(value => typeof value === 'string' && value.length > 0).slice(0, MAX_IDS)
          refresh = body !== null && typeof body === 'object' && body.refresh === true
        } catch (error) {
          return json(400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
        }
        try {
          const values = await mapLimit(ids, CONCURRENCY, id => sessionFacts(ctx, id, refresh))
          const value = {}
          ids.forEach((id, index) => { value[id] = values[index] })
          return json(200, { ok: true, value })
        } catch (error) {
          return json(500, { ok: false, error: { code: 'stats-failed', message: String(error?.message ?? error) } })
        }
      },
    })
    return () => { void dispose() }
  }, 'dsh-session-manager: stats route')

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: DELETE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        let ids = []
        try {
          const body = await request.json()
          const raw = body && Array.isArray(body.ids) ? body.ids : []
          ids = raw.filter(value => typeof value === 'string' && value.length > 0).slice(0, MAX_IDS)
        } catch (error) {
          return json(400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
        }
        if (ids.length === 0) {
          return json(400, { ok: false, error: { code: 'empty-request', message: 'no session ids were supplied' } })
        }
        const results = await mapLimit(ids, 1, id => deleteSession(ctx, id))
        const deleted = results.filter(result => result.ok).map(result => result.id)
        const failed = results.filter(result => !result.ok)
        return json(200, { ok: true, value: { deleted, failed } })
      },
    })
    return () => { void dispose() }
  }, 'dsh-session-manager: delete route')

  /**
   * Register one JSON POST route with the shared envelope.
   * @param path - Route path.
   * @param handle - Body → `{ ok, value | error }` envelope.
   */
  const postRoute = (path, handle) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        let body
        try {
          body = await request.json()
        } catch (error) {
          return json(400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
        }
        try {
          return json(200, await handle(body))
        } catch (error) {
          return json(500, { ok: false, error: { code: 'handler-failed', message: String(error?.message ?? error) } })
        }
      },
    })
    return () => { void dispose() }
  }, 'dsh-session-manager: ' + path)

  postRoute(HIDE_PATH, async body => {
    const id = body && typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (id === '') return { ok: false, error: { code: 'bad-request', message: 'workspaceId is required' } }
    const result = await hideWorkspace(ctx, id)
    return result.ok === true
      ? { ok: true, value: result.record }
      : { ok: false, error: { code: result.code, message: result.message } }
  })

  postRoute(RESTORE_PATH, async body => {
    const record = body && typeof body.record === 'object' && body.record !== null ? body.record : {}
    const confirmMerge = body !== null && typeof body === 'object' && body.confirmMerge === true
    const result = await restoreWorkspace(ctx, record, confirmMerge)
    return result.ok === true
      ? { ok: true, value: result.value }
      : { ok: false, error: { code: result.code, message: result.message } }
  })
}
