/**
 * Self-test for the rewritten search engines (Engine A rg / Engine B JS).
 * Builds a fixture tree in a temp dir and asserts feature parity:
 * literal / case / wholeWord / regex / invalid-regex / lookahead difference /
 * include-exclude globs / smartCase / long-line preview / Unicode char
 * offsets / truncation / engine selection. Run: node scripts/self-test.mjs
 */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { searchContent } from '../lib/index.js'

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
async function expectInvalid(fn, code, name) {
  try {
    await fn()
    check(name + ' (should throw)', false)
  } catch (err) {
    check(name, err && err.code === code, err && err.code + ': ' + err.message)
  }
}

const rgProbe = spawnSync('rg', ['--version'], { encoding: 'utf8' })
const rgRunnable = rgProbe.status === 0
console.log('rg probe:', rgRunnable ? 'available' : 'MISSING (sandboxed session: rg section skipped)')

const root = await mkdtemp(join(tmpdir(), 'fts-fixture-'))
await mkdir(join(root, 'sub'), { recursive: true })
await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
await mkdir(join(root, '.git'), { recursive: true })
await writeFile(join(root, 'a.txt'), 'Hello World\nfoo bar\nFOO BAZ\nfoofoo\nhello foo again\n')
await writeFile(join(root, 'sub', 'b.txt'), 'nested foo here\nnothing\n')
await writeFile(join(root, 'case.txt'), 'Foo Foo FOO\n')
await writeFile(join(root, 'x.ts'), 'const foo = 1;\n')
await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'foo in node_modules\n')
await writeFile(join(root, '.git', 'config'), 'foo in git\n')
await writeFile(join(root, 'bin.dat'), Buffer.from('foo\x00bar\n'))
await writeFile(join(root, 'long.txt'), 'x'.repeat(400) + ' foo here ' + 'y'.repeat(200) + '\n')
await writeFile(join(root, 'unicode.txt'), '中文foo中文\nfoobar foo\n')
await writeFile(join(root, 'multi.txt'), 'xx foo\nbar yy\n')

const rels = (r) => [...new Set(r.matches.map((m) => m.rel))].sort()
const linesOf = (r) => r.matches.map((m) => m.rel + ':' + m.lineNumber)

for (const engine of rgRunnable ? ['js', 'rg'] : ['js']) {
  console.log(`\n=== engine ${engine} ===`)

  let r = await searchContent(root, 'foo', { engine })
  check('literal basic files', ['a.txt', 'case.txt', 'long.txt', 'multi.txt', 'sub/b.txt', 'unicode.txt', 'x.ts'].every((f) => rels(r).includes(f)), rels(r))
  check('skip node_modules/.git/bin', !rels(r).includes('node_modules/pkg/index.js') && !rels(r).includes('.git/config') && !rels(r).includes('bin.dat'), rels(r))
  check('engine tag', r.engine === engine, r.engine)
  check('files count', r.files === rels(r).length, r.files)

  r = await searchContent(root, 'Foo', { engine, caseSensitive: true })
  check('caseSensitive', rels(r).length === 1 && rels(r)[0] === 'case.txt', rels(r))

  r = await searchContent(root, 'foo', { engine, wholeWord: true })
  const ww = linesOf(r)
  check('wholeWord excludes foofoo', !ww.some((l) => l.startsWith('a.txt:4')), ww)
  check('wholeWord includes bounded', ww.some((l) => l.startsWith('a.txt:2')) && ww.some((l) => l.startsWith('a.txt:3')), ww)

  r = await searchContent(root, 'f.o', { engine, isRegex: true })
  check('regex f.o', linesOf(r).some((l) => l.startsWith('a.txt:3')) && linesOf(r).some((l) => l.startsWith('case.txt:1')), linesOf(r))

  await expectInvalid(() => searchContent(root, '(', { engine, isRegex: true }), 'invalid-regex', engine + ' invalid regex')

  if (engine === 'js') {
    const lr = await searchContent(root, '(?=foo)', { engine, isRegex: true })
    check('js lookahead supported', lr.matches.length > 0, lr.matches.length)
  } else {
    await expectInvalid(() => searchContent(root, '(?=foo)', { engine, isRegex: true }), 'invalid-regex', 'rg lookahead rejected (VSCode parity)')
  }

  r = await searchContent(root, 'foo', { engine, include: ['sub/**'] })
  check('include sub/**', rels(r).length === 1 && rels(r)[0] === 'sub/b.txt', rels(r))

  r = await searchContent(root, 'foo', { engine, exclude: ['**/sub/**'] })
  check('exclude **/sub/**', !rels(r).includes('sub/b.txt') && rels(r).includes('a.txt'), rels(r))

  r = await searchContent(root, 'Foo', { engine, smartCase: true })
  check('smartCase auto-sensitive', rels(r).length === 1 && rels(r)[0] === 'case.txt', rels(r))

  r = await searchContent(root, 'foo', { engine })
  const long = r.matches.find((m) => m.rel === 'long.txt')
  check('long preview capped', long && long.line.length <= 243, long && long.line.length)
  check('long preview keeps match', long && long.line.includes('foo'), long && long.line)
  check('long preview ellipsis', long && long.line.startsWith('…') && long.line.endsWith('…'), long && long.line)
  check('long spans inside preview', long && long.matchStart >= 0 && long.matchEnd > long.matchStart && long.matchEnd <= long.line.length, long && [long.matchStart, long.matchEnd, long.line.length])

  const u = r.matches.find((m) => m.rel === 'unicode.txt' && m.lineNumber === 1)
  check('unicode char offsets', u && u.matchStart === 2 && u.matchEnd === 5, u && [u.matchStart, u.matchEnd, u.line])

  const ab = r.matches.find((m) => m.rel === 'a.txt' && m.lineNumber === 2)
  check('spans on foo bar', ab && ab.matchStart === 0 && ab.matchEnd === 3, ab && [ab.matchStart, ab.matchEnd])

  r = await searchContent(root, 'foo', { engine, maxMatches: 2 })
  check('maxMatches truncates', r.truncated === true && r.matches.length === 2, [r.truncated, r.matches.length])

  r = await searchContent(root, 'foo', { engine, exclude: ['**/*.ts'] })
  check('exclude glob *.ts', !rels(r).includes('x.ts'), rels(r))
}

// multiline: rg-only capability
if (rgRunnable) {
  let r = await searchContent(root, 'foo\nbar', { engine: 'rg', isRegex: true, multiline: true })
  check('rg multiline matches across lines', r.matches.length === 1 && r.matches[0].rel === 'multi.txt', r.matches.map((m) => m.rel + ':' + m.lineNumber))
}
{
  const r = await searchContent(root, 'foo\nbar', { engine: 'js', isRegex: true })
  check('js per-line never matches across lines', r.matches.length === 0, r.matches.length)
}

// engine selection
const auto = await searchContent(root, 'foo', {})
const expected = rgRunnable ? 'rg' : 'js'
check('auto selects ' + expected, auto.engine === expected, auto.engine)

await rm(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
