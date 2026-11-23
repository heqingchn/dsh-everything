/**
 * Compare the two transport routes on this machine.
 *
 * The only claim that needs measuring rather than asserting is latency: the SDK
 * bridge answers in-process, while the plugin this package merges from spawned one
 * `es.exe` per query. Both are asked the same question about the same folder with
 * the same page size, alternately, so a warm cache cannot favour one.
 *
 * Usage: node scripts/bench-query.mjs [--iterations 20] [--scope <dir>] [--es <path>]
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SdkBridge } from '../lib/sdk.js'

const args = process.argv.slice(2)
/** Read one `--name value` argument. */
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : args[index + 1]
}

const ITERATIONS = Number(option('iterations', '20'))
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCOPE = option('scope', 'D:\\code\\CodeBase\\github')
const ES = option('es', path.join(path.dirname(ROOT), 'dsh-at-file-everything', 'bin', 'es.exe'))
const FRAGMENT = 'package'
const PAGE = 300

const bridge = new SdkBridge({
  dllPath: path.join(ROOT, 'native', 'Everything64.dll'),
  koffiPath: path.join(ROOT, 'vendor', 'koffi', 'index.cjs'),
  workerPath: path.join(ROOT, 'sdk-worker.cjs'),
  timeoutMs: 30000,
})

/**
 * Run one query through the SDK bridge.
 * @returns the elapsed milliseconds.
 */
async function ffiOnce() {
  const started = performance.now()
  const page = await bridge.query({ query: `path:"${SCOPE}" *${FRAGMENT}*`, max: PAGE })
  const elapsed = performance.now() - started
  if (!page.ok) throw new Error(JSON.stringify(page))
  return elapsed
}

/**
 * Run one query through es.exe, including its CSV export round trip.
 * @returns the elapsed milliseconds.
 */
async function esOnce() {
  // `es.exe -export-csv` refuses to create a file under `%TEMP%` on at least one
  // machine (exit 5, "Failed to create output file"), which is why this uses a
  // directory beside the checkout: the benchmark must measure the client, not a
  // file-system policy.
  const directory = path.join(ROOT, '.bench')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'results.csv')
  await rm(file, { force: true })
  const started = performance.now()
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ES, [
        '-path', SCOPE,
        '-n', String(PAGE),
        '-csv', '-attributes', '-utf8-bom',
        '-export-csv', file,
        `*${FRAGMENT}*`,
        '-no-result-error',
      ], { windowsHide: true, stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 || code === 9 ? resolve() : reject(new Error(`es.exe exited ${String(code)}`))))
    })
    await readFile(file, 'utf8').catch(() => '')
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
  return performance.now() - started
}

/** Median and 95th percentile of a sample. */
function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
  return { p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] }
}

/** Round for display. */
const ms = (value) => `${value.toFixed(1)} ms`

const status = await bridge.status()
if (!status.available) {
  console.error('Everything is not answering; cannot benchmark:', status.error)
  await bridge.dispose()
  process.exit(2)
}
console.log(`Everything ${status.clientVersion} · ${status.indexedItems} indexed items`)
console.log(`scope: ${SCOPE} · fragment: ${FRAGMENT} · page: ${PAGE} · iterations: ${ITERATIONS}\n`)

// Warm both paths first: the first SDK call loads the DLL and the first es.exe
// call pays disk cache.
await ffiOnce()
await esOnce().catch((error) => console.error('es.exe warm-up failed:', error.message))

const ffi = []
const es = []
for (let index = 0; index < ITERATIONS; index += 1) {
  ffi.push(await ffiOnce())
  es.push(await esOnce())
}

const ffiStats = stats(ffi)
const esStats = stats(es)
console.log('route        p50        p95        min        max')
console.log(`SDK bridge   ${ms(ffiStats.p50).padEnd(10)} ${ms(ffiStats.p95).padEnd(10)} ${ms(ffiStats.min).padEnd(10)} ${ms(ffiStats.max)}`)
console.log(`es.exe       ${ms(esStats.p50).padEnd(10)} ${ms(esStats.p95).padEnd(10)} ${ms(esStats.min).padEnd(10)} ${ms(esStats.max)}`)
console.log(`\nratio (p50): ${(esStats.p50 / ffiStats.p50).toFixed(1)}x  ·  ratio (p95): ${(esStats.p95 / ffiStats.p95).toFixed(1)}x`)

await bridge.dispose()
