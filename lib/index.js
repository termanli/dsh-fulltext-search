/**
 * dsh-fulltext-search — host half.
 *
 * Registers the fenced `/fts/api` JSON API with one method:
 *
 *   POST /fts/api/search  { sessionId, query, isRegex?, caseSensitive?,
 *                           smartCase?, wholeWord?, include?, exclude?,
 *                           useIgnoreFiles?, multiline?, engine?, maxMatches? }
 *   → { ok: true, value: { matches, files, truncated, engine } }
 *
 *   The search root is ALWAYS the server-recorded working directory of the
 *   session named by `sessionId`. A client-supplied `cwd` is never honored:
 *   the trust fence proves the request's origin, not that the requester owns
 *   the session or its directory, so honoring a forged `sessionId` plus an
 *   arbitrary absolute `cwd` would widen full-text search to any readable
 *   host directory. Non-existent sessions are rejected (404) and sessions
 *   without a recorded cwd are rejected (400) — there is no fallback to
 *   request-body cwd or process.cwd().
 *
 * Matching is backed by two engines behind one protocol (VSCode-search
 * parity: literal or regex queries, match case, smart case, whole-word exact
 * matching, include/exclude globs, optional .gitignore honoring):
 *
 *   • Engine A — ripgrep: spawns the system `rg` binary when present
 *     (multi-threaded, SIMD-prefiltered, ignore-file aware — the same engine
 *     VSCode search uses). It is the default whenever `rg` is on PATH; any
 *     unexpected failure falls back to Engine B.
 *   • Engine B — pure JS: a worker-thread pool over a main-thread traversal,
 *     zero external dependencies, always available.
 *
 * Every match row carries its highlight spans (char offsets into the preview)
 * so the client can render highlights without re-searching. Budgets bound the
 * walk in both engines (visited entries, match rows, bytes per file, matches
 * per file), `.git` and a small set of heavyweight directories are skipped,
 * and symlinked directories are never descended (cycle safety). The walk
 * never escapes the session cwd — the root is the server-recorded session
 * working directory, and there is no caller-targetable path input.
 *
 * Every request passes the same browser-trust fence as the /api gateway
 * (Host-header loopback or the web runtime's trustedHosts), mirroring
 * dsh-better-sidebar's own route hardening. The fence alone does NOT
 * authorize a session: session ownership is enforced separately by
 * resolveSessionCwd(), which rejects unknown sessionIds outright.
 */
import { opendir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { compileMatcher, compileGlobs, globMatch, scanFileAt, trimPreview, MAX_LINE_CHARS } from './search-core.js'

// ── plugin identity ─────────────────────────────────────────────────────────
export const name = 'dsh-fulltext-search'
/** Services required before mounting: the webserver routes, the session
 *  store (authoritative cwd), and the web runtime's trusted hosts. */
export const inject = ['webServer', 'sessions', 'webRuntime']

// ── browser-trust fence (mirror of dsh-better-sidebar/src/trust-fence.ts,
//    BSD-3-Clause; behaviorally identical to the /api gateway's fence) ──────
function header(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── wire helpers (mirror of dsh-better-sidebar/src/wire.ts) ─────────────────
const MAX_BODY_BYTES = 1 << 20
class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}
function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}
function requireString(payload, key) {
  const record = payload
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new ApiError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

// ── session cwd resolution ───────────────────────────────────────────────────
/**
 * Resolve the authoritative search root for a session.
 *
 * SECURITY: the root MUST come from the server-side session record only. A
 * browser request can carry any `sessionId`/`cwd` it likes; the trust fence
 * proves the request's origin, not that the requester owns the session or its
 * directory. Non-existent sessions are rejected outright, and there is NO
 * fallback to request-body cwd or process.cwd() — otherwise a forged
 * sessionId plus an arbitrary absolute cwd would widen full-text search to
 * any readable host directory.
 *
 * @returns {string} the server-recorded session working directory
 * @throws {ApiError} 404 session-not-found | 400 no-session-cwd
 */
export function resolveSessionCwd(sessions, sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new ApiError('session-not-found', `session "${sessionId}" not found`, 404)
  }
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new ApiError('no-session-cwd', `session "${sessionId}" has no working directory`, 400)
  }
  return cwd
}

// ── budgets & skip rules ────────────────────────────────────────────────────
/** Directories never entered: VCS internals, dependency forests, and other
 *  heavyweight/non-source trees. Shared by both engines. */
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', '.jj',
  'node_modules', '.pnpm', '.yarn', 'bower_components',
  'Library', 'Temp', 'Obj', 'obj', 'Bin', 'bin', 'Dist', 'dist', 'out', 'build', 'target',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.idea', '.vscode', '.vs',
  '.dsh', '.cache', 'logs', 'Logs',
])

const DEFAULT_MAX_MATCHES = 500
const DEFAULT_MAX_VISITED = 100000
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_MATCHES_PER_FILE = 50
/** Wall-clock cap for one JS-engine search; workers are torn down after this. */
const OVERALL_TIMEOUT_MS = 30000

// ── engine selection ────────────────────────────────────────────────────────
let rgAvailableCache = undefined
/** Detect the system ripgrep once per process (cached). */
function rgAvailable() {
  if (rgAvailableCache === undefined) {
    try {
      const r = spawnSync('rg', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      rgAvailableCache = !r.error && r.status === 0
    } catch {
      rgAvailableCache = false
    }
  }
  return rgAvailableCache
}

function resolveEngine(raw) {
  const value = typeof raw === 'string' && raw !== '' ? raw : process.env.DSH_FTS_ENGINE || 'auto'
  if (value === 'auto' || value === 'rg' || value === 'js') return value
  throw new ApiError('bad-request', `invalid engine "${value}" (expected auto|rg|js)`)
}

function normalizeMatchError(err) {
  if (err && (err.code === 'invalid-regex' || err.code === 'invalid-glob')) {
    return new ApiError(err.code, err.message)
  }
  return err
}

function finalizeMatches(matches, maxMatches, truncated, engine) {
  let capped = matches
  if (matches.length > maxMatches) {
    truncated = true
    capped = matches.slice(0, maxMatches)
  }
  // Deterministic output: file path, then line number.
  capped.sort((a, b) => (a.rel === b.rel ? a.lineNumber - b.lineNumber : a.rel < b.rel ? -1 : 1))
  return { matches: capped, files: new Set(capped.map((m) => m.abs)).size, truncated, engine }
}

// ── Engine A: ripgrep ───────────────────────────────────────────────────────
/** Build the rg argument vector for a search (pure; shared with tests). */
export function rgArgs(query, opts) {
  const args = ['--json', '--line-number', '--no-heading', '--hidden']
  if (!opts.isRegex) args.push('-F')
  if (opts.wholeWord) args.push('-w')
  if (opts.smartCase) args.push('--smart-case')
  else if (!opts.caseSensitive) args.push('-i')
  if (opts.maxMatchesPerFile) args.push('-m', String(opts.maxMatchesPerFile))
  if (opts.maxFileBytes) args.push('--max-filesize', String(opts.maxFileBytes))
  if (!opts.useIgnoreFiles) args.push('--no-ignore')
  if (opts.multiline) args.push('--multiline')
  for (const g of opts.include) args.push('-g', g)
  for (const g of opts.exclude) args.push('-g', `!${g}`)
  for (const name of SKIP_DIRS) args.push('-g', `!${name}`, '-g', `!${name}/**`)
  // Run with cwd = search root and path "." so -g globs match paths relative
  // to the root (same semantics as the JS engine's rel-based filtering).
  args.push('--', query, '.')
  return args
}

/**
 * Convert one rg JSON `match` message into a match row (pure; shared with
 * tests). rg submatches carry BYTE offsets into the UTF-8 line; they are
 * converted to char offsets so highlight spans match the JS engine exactly.
 * Returns null for malformed messages.
 */
export function rgMatchRow(data, root) {
  const pathText = data && data.path && data.path.text
  if (!pathText || !data.lines) return null
  const relPath = pathText.replace(/^\.\//, '')
  const abs = isAbsolute(relPath) ? relPath : join(root, relPath)
  const line = data.lines.text || ''
  const byteLine = Buffer.from(line, 'utf8')
  const spans = (data.submatches || [])
    .map((s) => [
      byteLine.subarray(0, s.start).toString('utf8').length,
      byteLine.subarray(0, s.end).toString('utf8').length,
    ])
    .filter((s) => s[1] >= s[0])
  const { line: preview, spans: adj } = trimPreview(line, spans, MAX_LINE_CHARS)
  return {
    abs,
    rel: relative(root, abs).split(sep).join('/'),
    lineNumber: data.line_number || 0,
    line: preview,
    matchStart: adj.length ? adj[0][0] : 0,
    matchEnd: adj.length ? adj[0][1] : 0,
    spans: adj,
  }
}

/**
 * Search with the system ripgrep. Maps every search option to its rg flag
 * and parses the `--json` stream into the same match-row shape as Engine B.
 * Resolves with `{ matches, files, truncated, engine: 'rg' }`; rejects with
 * an Error carrying `rgError = true` on rg failures (exit code 2).
 */
async function searchRg(root, query, opts) {
  const args = rgArgs(query, opts)

  const child = spawn('rg', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const matches = []
  const matchedFiles = new Set()
  let visited = 0
  let truncated = false
  let stderr = ''

  await new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn) => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => settle(() => reject(err)))
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (lineText) => {
      if (lineText.trim() === '') return
      let msg
      try {
        msg = JSON.parse(lineText)
      } catch {
        return
      }
      if (msg.type === 'begin') {
        visited += 1
        if (visited > opts.maxVisited) {
          truncated = true
          child.kill()
        }
        return
      }
      if (msg.type !== 'match') return
      const row = rgMatchRow(msg.data, root)
      if (!row) return
      matchedFiles.add(row.abs)
      matches.push(row)
      if (matches.length >= opts.maxMatches) {
        truncated = true
        child.kill()
      }
    })
    child.on('close', (code) => {
      if (code === 2) {
        const text = stderr.trim()
        settle(() => reject(Object.assign(new Error(text || 'ripgrep failed'), { rgError: true })))
      } else {
        settle(() => resolve())
      }
    })
  })

  return finalizeMatches(matches, opts.maxMatches, truncated, 'rg')
}

// ── Engine B: pure JS (main-thread traversal + worker pool) ─────────────────
function shardFiles(files, count) {
  const shards = []
  const size = Math.max(1, Math.ceil(files.length / count))
  for (let i = 0; i < files.length; i += size) shards.push({ id: shards.length, files: files.slice(i, i + size) })
  return shards
}

/** DFS file collection on the main thread; glob filters apply here so
 *  excluded trees are pruned before any worker touches them. */
async function collectFiles(root, opts) {
  const files = []
  let visited = 0
  let truncated = false
  const skip = new Set(SKIP_DIRS)
  const includeRe = compileGlobs(opts.include)
  const excludeRe = compileGlobs(opts.exclude)
  const relOf = (full) => relative(root, full).split(sep).join('/')
  const walk = async (dir) => {
    if (truncated) return
    let level
    try {
      level = await opendir(dir)
    } catch {
      return
    }
    for await (const dirent of level) {
      if (truncated) return
      visited += 1
      if (visited > opts.maxVisited) {
        truncated = true
        return
      }
      const full = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        // Never descend symlinked directories (cycle safety) or skip names.
        if (dirent.isSymbolicLink()) continue
        if (skip.has(dirent.name)) continue
        const rel = relOf(full)
        if (excludeRe.length && (globMatch(excludeRe, rel) || globMatch(excludeRe, `${rel}/`))) continue
        await walk(full)
      } else if (dirent.isFile()) {
        const rel = relOf(full)
        if (excludeRe.length && globMatch(excludeRe, rel)) continue
        if (includeRe.length && !globMatch(includeRe, rel)) continue
        files.push(full)
      }
    }
  }
  await walk(root)
  return { files, truncated }
}

/** Worker-pool matching over the collected file list. Results accumulate in
 *  `sink`; `markTruncated(true)` is called on any budget/timeout hit.
 *  Tasks are dispatched round-robin across live workers; a crashed worker is
 *  skipped (its in-flight shard is accounted and the pool continues). */
async function runJsPool(root, files, matcher, opts, sink, markTruncated) {
  return new Promise((resolvePromise) => {
    const W = Math.min(Math.max(1, availableParallelism() - 1), 8, files.length)
    const shards = shardFiles(files, W)
    const workers = []
    const dead = new Set()
    let next = 0
    let nextWorker = 0
    let pending = 0
    let done = false
    const deadline = Date.now() + OVERALL_TIMEOUT_MS
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const w of workers) w.terminate()
      resolvePromise()
    }
    const timer = setTimeout(() => {
      markTruncated(true)
      finish()
    }, OVERALL_TIMEOUT_MS)
    const dispatch = () => {
      if (done) return
      if (next >= shards.length || sink.length >= opts.maxMatches) {
        if (pending === 0) finish()
        return
      }
      for (let i = 0; i < workers.length; i += 1) {
        const w = workers[(nextWorker + i) % workers.length]
        if (dead.has(w)) continue
        const shard = shards[next]
        try {
          w.postMessage({
            type: 'task',
            taskId: shard.id,
            root,
            files: shard.files,
            matcher,
            opts: {
              maxFileBytes: opts.maxFileBytes,
              maxMatchesPerFile: opts.maxMatchesPerFile,
              maxMatchesTotal: opts.maxMatches,
            },
            deadline,
          })
        } catch {
          continue // worker died mid-flight: try the next live one
        }
        nextWorker = (nextWorker + i + 1) % workers.length
        next += 1
        pending += 1
        return
      }
      // no live workers left
      markTruncated(true)
      finish()
    }
    const onResult = (msg) => {
      if (done || !msg || msg.type !== 'result') return
      pending -= 1
      if (msg.matches) sink.push(...msg.matches)
      if (msg.timedOutFiles > 0) markTruncated(true)
      if (msg.stopped || sink.length >= opts.maxMatches) markTruncated(true)
      dispatch()
    }
    for (let i = 0; i < W; i += 1) {
      const w = new Worker(new URL('./search.worker.js', import.meta.url))
      workers.push(w)
      w.on('message', onResult)
      w.on('error', () => {
        if (done) return
        dead.add(w)
        pending -= 1
        markTruncated(true)
        dispatch()
      })
    }
    for (let i = 0; i < W; i += 1) dispatch()
  })
}

/** Sequential fallback when worker_threads is unavailable. */
async function runJsInline(root, files, matcher, opts, sink, markTruncated) {
  const relOf = (full) => relative(root, full).split(sep).join('/')
  const deadline = Date.now() + OVERALL_TIMEOUT_MS
  for (const full of files) {
    if (Date.now() > deadline) {
      markTruncated(true)
      break
    }
    const res = await scanFileAt(full, relOf(full), matcher, opts, () => Date.now() > deadline)
    if (res === 'timedOut') {
      markTruncated(true)
      continue
    }
    if (res && res.entries) sink.push(...res.entries)
    if (sink.length >= opts.maxMatches) {
      markTruncated(true)
      break
    }
  }
}

/** Full JS-engine search: collect → match (pool, inline fallback) → sort. */
async function searchJs(root, query, opts) {
  let matcher
  try {
    matcher = compileMatcher(query, opts)
  } catch (err) {
    throw normalizeMatchError(err)
  }
  let collected
  try {
    collected = await collectFiles(root, opts)
  } catch (err) {
    throw normalizeMatchError(err)
  }
  const { files, truncated: traversalTruncated } = collected
  const matches = []
  let truncated = traversalTruncated
  const markTruncated = (t) => {
    if (t) truncated = true
  }
  if (files.length > 0) {
    try {
      await runJsPool(root, files, matcher, opts, matches, markTruncated)
    } catch {
      // worker_threads unavailable in this host → main-thread fallback
      await runJsInline(root, files, matcher, opts, matches, markTruncated)
    }
  }
  return finalizeMatches(matches, opts.maxMatches, truncated, 'js')
}

// ── full-text search entry ──────────────────────────────────────────────────
/**
 * Search `root` for `query` with the requested (or auto-selected) engine.
 * `opts`: engine, isRegex, caseSensitive, smartCase, wholeWord,
 * useIgnoreFiles, multiline, include, exclude, maxMatches, and the budget
 * overrides (maxVisited / maxFileBytes / maxMatchesPerFile).
 *
 * @returns {Promise<{matches: Array, files: number, truncated: boolean, engine: string}>}
 */
export async function searchContent(root, query, opts = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    return { matches: [], files: 0, truncated: false, engine: 'none' }
  }
  const full = {
    engine: opts.engine ?? 'auto',
    isRegex: opts.isRegex === true,
    caseSensitive: opts.caseSensitive === true,
    smartCase: opts.smartCase === true,
    wholeWord: opts.wholeWord === true,
    useIgnoreFiles: opts.useIgnoreFiles === true,
    multiline: opts.multiline === true,
    include: Array.isArray(opts.include) ? opts.include : [],
    exclude: Array.isArray(opts.exclude) ? opts.exclude : [],
    maxMatches: typeof opts.maxMatches === 'number' && Number.isFinite(opts.maxMatches)
      ? Math.max(1, Math.min(5000, Math.floor(opts.maxMatches)))
      : DEFAULT_MAX_MATCHES,
    maxVisited: DEFAULT_MAX_VISITED,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxMatchesPerFile: DEFAULT_MAX_MATCHES_PER_FILE,
  }
  const wanted = full.engine === 'auto' ? (rgAvailable() ? 'rg' : 'js') : full.engine
  if (wanted === 'rg') {
    if (!rgAvailable()) {
      if (full.engine === 'rg') throw new ApiError('internal', 'ripgrep is not available on this host', 500)
      return searchJs(root, query, full)
    }
    try {
      return await searchRg(root, query, full)
    } catch (err) {
      if (err && err.rgError) {
        const message = err.message || ''
        if (/glob/i.test(message)) throw new ApiError('invalid-glob', message)
        if (/regex|pattern|parse/i.test(message)) throw new ApiError('invalid-regex', message)
        if (full.engine === 'rg') throw new ApiError('internal', `ripgrep failed: ${message}`, 500)
        return searchJs(root, query, full)
      }
      throw err
    }
  }
  return searchJs(root, query, full)
}

// ── plugin body ─────────────────────────────────────────────────────────────
/** Build the fenced /fts/api request handler (exported for testing with a
 *  stubbed ctx). The fence checks the request ORIGIN only; session ownership
 *  is enforced per-method by resolveSessionCwd(). */
export function createFtsHandler(ctx) {
  const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)

  return async (req, res) => {
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = pathname.startsWith('/fts/api/') ? pathname.slice('/fts/api/'.length) : undefined
    if (method === undefined || method.includes('/')) {
      writeError(res, new ApiError('not-found', 'unknown fulltext API method', 404))
      return
    }
    try {
      const payload = await readJsonBody(req)
      if (method === 'search') {
        const sessionId = requireString(payload, 'sessionId')
        const query = requireString(payload, 'query')
        // Security: a client-supplied `cwd` is ignored. The search root comes
        // exclusively from the server-side session record (resolveSessionCwd
        // rejects unknown sessionIds and sessions without a recorded cwd).
        const cwd = resolveSessionCwd(ctx.sessions, sessionId)
        const value = await searchContent(cwd, query, {
          engine: resolveEngine(payload.engine),
          isRegex: payload.isRegex === true,
          caseSensitive: payload.caseSensitive === true,
          smartCase: payload.smartCase === true,
          wholeWord: payload.wholeWord === true,
          useIgnoreFiles: payload.useIgnoreFiles === true,
          multiline: payload.multiline === true,
          include: sanitizeGlobList(payload.include, 'include'),
          exclude: sanitizeGlobList(payload.exclude, 'exclude'),
          maxMatches: payload.maxMatches,
        })
        writeOk(res, value)
        return
      }
      throw new ApiError('not-found', `unknown fulltext API method "${method}"`, 404)
    } catch (error) {
      writeError(res, error)
    }
  }
}

/** Plugin body: mount the fenced /fts/api routes. */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/fts/api',
        handler: createFtsHandler(ctx),
      }),
    'dsh-fulltext-search: /fts/api routes',
  )
}

function sanitizeGlobList(raw, key) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new ApiError('bad-request', `"${key}" must be an array of glob strings`)
  }
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ApiError('bad-request', `"${key}" entries must be non-empty strings`)
    }
    out.push(item)
  }
  return out
}
