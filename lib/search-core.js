/**
 * dsh-fulltext-search — shared matching core (host-side, dependency-free).
 *
 * Used by BOTH the main thread (lib/index.js) and the worker pool
 * (lib/search.worker.js). Pure matching logic lives here so both engines and
 * both threads behave identically: query compilation, per-line matching,
 * preview trimming, glob compilation, and the thin stat→read→match file
 * wrapper. Only node: builtins are used.
 *
 * Error convention: compileMatcher / compileGlobs throw a plain
 * `{ code: 'invalid-regex' | 'invalid-glob', message }` object; callers map
 * it to an ApiError at the wire boundary.
 */
import { stat, readFile } from 'node:fs/promises'

/** Display cap for a matching line's preview text. */
export const MAX_LINE_CHARS = 240

/** Word characters for whole-word matching (Unicode-aware, like rg -w). */
const WORD_RE = /[\p{L}\p{N}_]/u
export function isWordChar(ch) {
  return WORD_RE.test(ch)
}

/**
 * Compile a query option set into a serializable matcher (structured-clone
 * safe: it contains at most a RegExp, strings, and booleans).
 *
 * Semantics (VSCode-search parity):
 *   - isRegex        — treat `query` as a JS (ECMAScript) regular expression.
 *   - caseSensitive  — exact-case matching.
 *   - smartCase      — auto case-sensitive when the query contains an
 *                      uppercase letter (VSCode search.smartCase).
 *   - wholeWord      — only match at Unicode word boundaries; regex queries
 *                      are wrapped in lookarounds so the user's groups stay
 *                      untouched.
 */
export function compileMatcher(query, opts = {}) {
  const { isRegex = false, caseSensitive = false, smartCase = false, wholeWord = false } = opts
  const sensitive = caseSensitive || (smartCase && /[A-Z]/.test(query))
  if (isRegex) {
    let source = query
    let flags = 'g'
    if (!sensitive) flags += 'i'
    if (wholeWord) {
      // Unicode-aware word boundaries via lookaround; requires the u flag.
      source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
      flags += 'u'
    }
    let re
    try {
      re = new RegExp(source, flags)
    } catch (err) {
      throw { code: 'invalid-regex', message: String(err && err.message ? err.message : err) }
    }
    return { kind: 'regex', re, caseSensitive: sensitive }
  }
  const needle = sensitive ? query : query.toLowerCase()
  return { kind: 'literal', needle, caseSensitive: sensitive, wholeWord }
}

/** All [start, end) char spans of the literal needle inside `line`, or null. */
function literalSpans(line, matcher) {
  const hay = matcher.caseSensitive ? line : line.toLowerCase()
  const needle = matcher.needle
  if (needle === '') return null
  const spans = []
  let pos = 0
  for (;;) {
    const idx = hay.indexOf(needle, pos)
    if (idx === -1) break
    if (!matcher.wholeWord || isBounded(hay, idx, needle.length)) {
      spans.push([idx, idx + needle.length])
    }
    pos = idx + needle.length
    if (pos > hay.length) break
  }
  return spans.length ? spans : null
}

function isBounded(hay, start, len) {
  const before = start > 0 ? hay[start - 1] : ''
  const after = start + len < hay.length ? hay[start + len] : ''
  return !isWordChar(before) && !isWordChar(after)
}

/** All [start, end) char spans of the regex inside `line`, or null. */
function regexSpans(line, matcher) {
  matcher.re.lastIndex = 0
  const spans = []
  let m
  while ((m = matcher.re.exec(line)) !== null) {
    if (m[0].length === 0) {
      // Zero-length match: advance to avoid an infinite loop.
      spans.push([m.index, m.index])
      matcher.re.lastIndex += 1
      if (matcher.re.lastIndex > line.length) break
      continue
    }
    spans.push([m.index, m.index + m[0].length])
    if (spans.length >= 64) break // safety cap for pathological lines
  }
  return spans.length ? spans : null
}

/** All matching spans of `line` under `matcher`, or null when none. */
export function matchLine(line, matcher) {
  return matcher.kind === 'regex' ? regexSpans(line, matcher) : literalSpans(line, matcher)
}

/**
 * Match every line of a decoded text file. Returns
 * `{ entries, timedOut }` where each entry is
 * `{ lineNumber, line, matchStart, matchEnd, spans }` (preview already
 * trimmed; offsets are char offsets into the preview).
 */
export function matchTextLines(text, matcher, { maxMatchesPerFile = 50, maxChars = MAX_LINE_CHARS, isExpired = null } = {}) {
  const lines = text.split('\n')
  const entries = []
  let timedOut = false
  let lineMatches = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (isExpired && isExpired()) {
      timedOut = true
      break
    }
    const spans = matchLine(lines[i], matcher)
    if (!spans) continue
    const { line, spans: adj } = trimPreview(lines[i], spans, maxChars)
    entries.push({
      lineNumber: i + 1,
      line,
      matchStart: adj.length ? adj[0][0] : 0,
      matchEnd: adj.length ? adj[0][1] : 0,
      spans: adj,
    })
    lineMatches += 1
    if (lineMatches >= maxMatchesPerFile) break
  }
  return { entries, timedOut }
}

/**
 * Trim a matched line to a display window that keeps the first match visible
 * (match-first truncation — previews never hide the highlight). Returns
 * `{ line, spans }` with spans re-mapped into the returned preview string.
 */
export function trimPreview(line, spans, maxChars = MAX_LINE_CHARS) {
  const trimmed = line.replace(/\s+$/, '')
  if (trimmed.length <= maxChars) {
    return { line: trimmed, spans }
  }
  const first = spans.length ? spans[0] : [0, 0]
  const matchLen = Math.max(1, first[1] - first[0])
  let winStart = first[0] - Math.floor((maxChars - matchLen) / 2)
  if (winStart < 0) winStart = 0
  const maxStart = Math.max(0, trimmed.length - maxChars)
  if (winStart > maxStart) winStart = maxStart
  let winEnd = winStart + maxChars
  if (first[1] > winEnd) {
    // Match longer than the window: anchor the window at the match start.
    winStart = Math.max(0, first[1] - maxChars)
    winEnd = winStart + maxChars
  }
  const slice = trimmed.slice(winStart, winEnd)
  const prefix = winStart > 0 ? '…' : ''
  const suffix = winEnd < trimmed.length ? '…' : ''
  const shift = prefix.length - winStart
  const out = []
  for (const [s, e] of spans) {
    if (e <= winStart || s >= winEnd) continue
    out.push([
      Math.max(0, Math.min(prefix.length + slice.length, s + shift)),
      Math.max(0, Math.min(prefix.length + slice.length, e + shift)),
    ])
  }
  return { line: prefix + slice + suffix, spans: out }
}

/**
 * Thin file wrapper: stat → size gate → read → NUL probe → line match.
 * Returns null (skipped / vanished / binary), `'timedOut'` when the
 * per-file deadline fires mid-file, or `{ entries, timedOut }`.
 */
export async function scanFileAt(full, rel, matcher, opts, isExpired = null) {
  let info
  try {
    info = await stat(full)
  } catch {
    return null
  }
  if (!info.isFile() || info.size > opts.maxFileBytes) return null
  let buf
  try {
    buf = await readFile(full)
  } catch {
    return null
  }
  if (buf.includes(0)) return null
  const { entries, timedOut } = matchTextLines(buf.toString('utf8'), matcher, {
    maxMatchesPerFile: opts.maxMatchesPerFile,
    maxChars: opts.maxChars ?? MAX_LINE_CHARS,
    isExpired,
  })
  if (timedOut) return 'timedOut'
  return { entries: entries.map((e) => ({ abs: full, rel, ...e })) }
}

// ── globs (gitignore-flavored: bare names match any depth, ** crosses
//    separators, {a,b} alternates, [...] char classes) ──────────────────────

function escapeRegExpChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

function globToRegExpSource(glob) {
  let src = ''
  let i = 0
  const n = glob.length
  while (i < n) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 2
        if (glob[i] === '/') {
          src += '(?:.*/)?'
          i += 1
        } else {
          src += '.*'
        }
        continue
      }
      src += '[^/]*'
      i += 1
    } else if (ch === '?') {
      src += '[^/]'
      i += 1
    } else if (ch === '[') {
      let j = i + 1
      let cls = ''
      if (glob[j] === '!' || glob[j] === '^') {
        cls += '^'
        j += 1
      }
      let closed = false
      while (j < n) {
        if (glob[j] === ']') {
          closed = true
          break
        }
        cls += escapeRegExpChar(glob[j])
        j += 1
      }
      if (closed) {
        src += `[${cls}]`
        i = j + 1
      } else {
        src += '\\['
        i += 1
      }
    } else if (ch === '{') {
      const end = glob.indexOf('}', i)
      if (end !== -1) {
        const body = glob.slice(i + 1, end).split(',')
        src += `(?:${body.map((b) => [...b].map(escapeRegExpChar).join('')).join('|')})`
        i = end + 1
      } else {
        src += '\\{'
        i += 1
      }
    } else {
      src += escapeRegExpChar(ch)
      i += 1
    }
  }
  if (!glob.includes('/')) src = `(?:.*/)?${src}` // bare names match any depth
  return `^${src}$`
}

/**
 * Compile a glob list into anchored RegExps. Throws
 * `{ code: 'invalid-glob', message }` on empty entries. Matching is
 * case-insensitive on Windows (path semantics follow the platform).
 */
export function compileGlobs(list) {
  const out = []
  for (const raw of list) {
    const g = String(raw)
    if (g === '') throw { code: 'invalid-glob', message: 'empty glob pattern' }
    out.push(new RegExp(globToRegExpSource(g), process.platform === 'win32' ? 'i' : ''))
  }
  return out
}

/** True when `rel` matches any of the compiled globs. */
export function globMatch(regexes, rel) {
  if (regexes.length === 0) return true
  for (const re of regexes) {
    if (re.test(rel)) return true
  }
  return false
}
