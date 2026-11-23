/**
 * Measure what serialisation costs when several callers query at once.
 *
 * The bridge owns one worker and one pending map, so requests queue: the second
 * caller waits for the first query, the third for both, and so on. This script
 * issues N concurrent queries and reports each request's own wait, which is the
 * number a subagent would actually experience.
 *
 * Usage: node scripts/bench-concurrency.mjs [--scope <dir>] [--fragment <text>]
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SdkBridge } from '../lib/sdk.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : args[index + 1]
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCOPE = option('scope', 'D:\\code\\CodeBase\\github')
const FRAGMENT = option('fragment', 'package')
const LEVELS = (option('levels', '1,2,4,8,16')).split(',').map(Number).filter((n) => n > 0)

const bridge = new SdkBridge({
  dllPath: path.join(ROOT, 'native', 'Everything64.dll'),
  koffiPath: path.join(ROOT, 'vendor', 'koffi', 'index.cjs'),
  workerPath: path.join(ROOT, 'sdk-worker.cjs'),
  timeoutMs: 30000,
})

const status = await bridge.status()
if (!status.available) {
  console.error('Everything is not answering:', status.error)
  await bridge.dispose()
  process.exit(2)
}

/** One query, returning its own wall-clock wait including any queue time. */
async function one(started) {
  const page = await bridge.query({ query: `path:"${SCOPE}" *${FRAGMENT}*`, max: 300 })
  if (!page.ok) throw new Error(JSON.stringify(page))
  return performance.now() - started
}

/** Percentile of a sample. */
function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

// Warm the worker and the index cache so the first measured level is not paying
// for DLL load.
await one(performance.now())

console.log(`scope: ${SCOPE} · fragment: ${FRAGMENT} · max: 300`)
console.log('concurrent | total ms | waits per request (ms)              | p50   | p95')
for (const level of LEVELS) {
  const started = performance.now()
  const waits = await Promise.all(Array.from({ length: level }, () => one(performance.now())))
  const total = performance.now() - started
  const shown = waits.map((value) => value.toFixed(0).padStart(4)).join(' ')
  console.log(
    `${String(level).padStart(10)} | ${total.toFixed(0).padStart(8)} | ${shown.padEnd(35)} | ${percentile(waits, 0.5).toFixed(0).padStart(5)} | ${percentile(waits, 0.95).toFixed(0).padStart(5)}`,
  )
}

await bridge.dispose()
