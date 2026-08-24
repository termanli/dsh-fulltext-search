/**
 * dsh-fulltext-search — worker pool half (Engine B).
 *
 * Receives shards of file paths, scans each file through the shared matching
 * core under a per-file time budget (ReDoS guard) and an overall deadline,
 * and posts the collected matches back to the main thread via structured
 * clone. Pure node: builtins; no dependency on the plugin context.
 */
import { parentPort } from 'node:worker_threads'
import { relative, sep } from 'node:path'
import { scanFileAt } from './search-core.js'

const relOf = (root, full) => relative(root, full).split(sep).join('/')

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'task') return
  const { taskId, root, files, matcher, opts, deadline } = msg
  const matches = []
  let timedOutFiles = 0
  let stopped = false
  for (const full of files) {
    if (Date.now() > deadline) {
      stopped = true
      break
    }
    const res = await scanFileAt(full, relOf(root, full), matcher, opts, () => Date.now() > deadline)
    if (res === 'timedOut') {
      timedOutFiles += 1
      continue
    }
    if (res && res.entries) matches.push(...res.entries)
    if (matches.length >= opts.maxMatchesTotal) {
      stopped = true
      break
    }
  }
  parentPort.postMessage({ type: 'result', taskId, matches, timedOutFiles, stopped })
})
