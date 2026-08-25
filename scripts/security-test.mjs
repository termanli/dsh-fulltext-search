/**
 * Security regression tests for the /fts/api search root resolution.
 *
 * Reviewer-required regression: "forged sessionId + arbitrary absolute cwd
 * must fail" (dsh-web-ui community plugin PR review). Covers the P0 fix in
 * lib/index.js:
 *   - the search root comes ONLY from the server-side session record;
 *   - non-existent sessions are rejected (404 session-not-found);
 *   - sessions without a recorded cwd are rejected (400 no-session-cwd);
 *   - request-body cwd and process.cwd() fallbacks are gone.
 * Plain node assertions, no framework — same style as scripts/self-test.mjs.
 * Run: node scripts/security-test.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionCwd, createFtsHandler, apply } from '../lib/index.js'

let passed = 0
let failed = 0
function check(name, cond, extra) {
  if (cond) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}

// ── HTTP stubs ───────────────────────────────────────────────────────────────
/** Minimal IncomingMessage-like request: async-iterable JSON body. */
function fakeReq(method, url, body) {
  let sent = false
  const buf = Buffer.from(JSON.stringify(body))
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (sent) return Promise.resolve({ done: true })
          sent = true
          return Promise.resolve({ done: false, value: buf })
        },
      }
    },
  }
}

/** Minimal ServerResponse-like: capture status + body. */
function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) {
      out.status = status
    },
    end(text) {
      out.body = String(text)
    },
  }
}

/** Stub plugin ctx: captures the registered route handler, serves a
 *  sessions map, and keeps the trust fence passable via the loopback Host.
 *  Call apply(ctx) first so the effect registers the handler. */
function stubCtx(sessions) {
  let handler = null
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register({ handler: h }) {
        handler = h
      },
    },
    sessions: { get: (id) => sessions[id] },
    effect: (fn) => fn(),
  }
  return { ctx, handler: () => handler }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const base = await mkdtemp(join(tmpdir(), 'fts-security-'))
const rootA = join(base, 'ws-a')
const rootB = join(base, 'ws-b')
await mkdir(rootA)
await mkdir(rootB)
await writeFile(join(rootA, 'a.txt'), 'alpha-marker\n')
await writeFile(join(rootB, 'b.txt'), 'beta-marker\n')

// ── T0: signature guard — no clientCwd parameter is possible anymore ────────
check('T0 resolveSessionCwd takes only (sessions, sessionId)', resolveSessionCwd.length === 2, resolveSessionCwd.length)

// ── T1-T3: pure function layer ───────────────────────────────────────────────
// T1: forged sessionId → rejected outright
let err1 = null
try {
  resolveSessionCwd({ get: () => undefined }, 'forged-session')
} catch (e) {
  err1 = e
}
check('T1 forged sessionId rejected (session-not-found)', err1 && err1.code === 'session-not-found', err1 && err1.code)
check('T1 status 404', err1 && err1.status === 404, err1 && err1.status)

// T2: valid session → server-recorded cwd returned
const cwd2 = resolveSessionCwd({ get: (id) => (id === 's1' ? { header: { cwd: rootA } } : undefined) }, 's1')
check('T2 server-recorded cwd returned', cwd2 === rootA, cwd2)

// T3: session without a recorded cwd → rejected (never process.cwd())
let err3 = null
try {
  resolveSessionCwd({ get: () => ({ header: {} }) }, 's2')
} catch (e) {
  err3 = e
}
check('T3 missing session cwd rejected (no-session-cwd)', err3 && err3.code === 'no-session-cwd', err3 && err3.code)
check('T3 status 400', err3 && err3.status === 400, err3 && err3.status)
// Behavioral proof there is no process.cwd() fallback: the only non-throwing
// path returns exactly the session record's cwd.
const cwd3 = resolveSessionCwd({ get: () => ({ header: { cwd: rootB } }) }, 's3')
check('T3 returned root equals session record (never process.cwd())', cwd3 === rootB && cwd3 !== process.cwd(), cwd3)

// ── T4: wire layer — forged sessionId + arbitrary absolute cwd must fail ────
{
  const { ctx, handler } = stubCtx({}) // no sessions exist
  apply(ctx)
  // `cwd` points at a real, readable fixture containing the query — if the
  // handler honored it, this would return 200 with matches.
  const res = fakeRes()
  await handler()(fakeReq('POST', '/fts/api/search', { sessionId: 'forged', cwd: rootA, query: 'alpha-marker' }), res)
  const parsed = JSON.parse(res.out.body)
  check('T4 forged sessionId + absolute cwd -> HTTP 404', res.out.status === 404, res.out.status)
  check('T4 error code session-not-found', parsed.error && parsed.error.code === 'session-not-found', parsed.error)
  check('T4 no matches leak (value absent)', parsed.value === undefined, parsed.value)
}

// ── T5: wire layer — client-supplied cwd is ignored for a valid session ─────
{
  const { ctx, handler } = stubCtx({ s1: { header: { cwd: rootA } } })
  apply(ctx)
  // The query lives ONLY in rootB (the client-claimed cwd): must yield 0.
  const res = fakeRes()
  await handler()(fakeReq('POST', '/fts/api/search', { sessionId: 's1', cwd: rootB, query: 'beta-marker' }), res)
  const parsed = JSON.parse(res.out.body)
  check('T5 client cwd ignored: no matches from client cwd', res.out.status === 200 && parsed.value.matches.length === 0, [res.out.status, parsed.value && parsed.value.matches.length])
  // The query lives ONLY in rootA (the session cwd): must match, all under rootA.
  const res2 = fakeRes()
  await handler()(fakeReq('POST', '/fts/api/search', { sessionId: 's1', cwd: rootB, query: 'alpha-marker' }), res2)
  const parsed2 = JSON.parse(res2.out.body)
  const allInA = parsed2.value.matches.every((m) => m.abs.startsWith(rootA))
  check('T5 client cwd ignored: matches come from session root only', res2.out.status === 200 && allInA, [res2.out.status, parsed2.value && parsed2.value.matches.map((m) => m.abs)])
}

await rm(base, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
