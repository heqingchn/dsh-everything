/**
 * Probe the real SDK bridge without a Harness installation.
 *
 * Answers three questions the unit tests cannot: does the DLL load on this
 * machine, is Everything answering, and do the SDK's search-path and `parent:`
 * forms behave the way the query builders assume.
 *
 * Usage: `npm run probe` (or `node scripts/probe-sdk.mjs`).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SdkBridge } from '../lib/sdk.js'

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bridge = new SdkBridge({
  dllPath: path.join(PACKAGE_ROOT, 'native', 'Everything64.dll'),
  koffiPath: path.join(PACKAGE_ROOT, 'vendor', 'koffi', 'index.cjs'),
  workerPath: path.join(PACKAGE_ROOT, 'sdk-worker.cjs'),
  timeoutMs: 15000,
})

/** Render one result row for the console. */
const line = (row) => `${row.folder ? '[dir] ' : '      '}${row.path}`

try {
  const status = await bridge.status()
  console.log('status:', JSON.stringify(status, null, 2))
  if (!status.available) {
    process.exitCode = 2
    process.exit(2)
  }

  const started = performance.now()
  const all = await bridge.query({ query: '**', max: 3 })
  const elapsed = Math.round(performance.now() - started)
  if (!all.ok) {
    console.log('unfiltered query failed:', JSON.stringify(all))
    process.exitCode = 3
    process.exit(3)
  }
  console.log(`unfiltered query: ${all.total} total, ${all.returned} returned, ${elapsed} ms`)
  for (const row of all.results) console.log(line(row))

  // Scope: one folder's direct children, the form `@` directory listing uses.
  const first = all.results[0]
  const parentDir = first.path.slice(0, Math.max(first.path.lastIndexOf('\\'), first.path.lastIndexOf('/')))
  const listing = await bridge.query({
    query: `parent:"${parentDir.replaceAll('^', '^^')}" **`,
    max: 5,
  })
  if (!listing.ok) {
    console.log('parent: query failed:', JSON.stringify(listing))
    process.exitCode = 4
    process.exit(4)
  }
  console.log(`parent: listing of ${parentDir} -> ${listing.total} total, ${listing.returned} returned`)
  for (const row of listing.results) console.log(line(row))

  // Search path: the form `@` bare queries and `find_files` scope use.
  const scoped = await bridge.query({ query: `path:"${parentDir.replaceAll('^', '^^')}" *`, max: 5 })
  if (!scoped.ok) {
    console.log('path: query failed:', JSON.stringify(scoped))
    process.exitCode = 5
    process.exit(5)
  }
  console.log(`path: ${parentDir} -> ${scoped.total} total, ${scoped.returned} returned`)
  for (const row of scoped.results) console.log(line(row))
} finally {
  await bridge.dispose()
}
