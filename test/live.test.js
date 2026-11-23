/**
 * Live tests against the real Everything SDK.
 *
 * These are the only tests that prove the two query forms this plugin emits
 * actually mean what `query.ts` assumes: `parent:` matches a folder's direct
 * children, and `path:` scopes to a subtree. They self-skip when Everything is not
 * running, so the suite stays green on a machine without it — but they are the
 * ones that would have caught a wrong assumption about the SDK.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { SdkBridge } from '../lib/sdk.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const bridge = new SdkBridge({
  dllPath: path.join(ROOT, 'native', 'Everything64.dll'),
  koffiPath: path.join(ROOT, 'vendor', 'koffi', 'index.cjs'),
  workerPath: path.join(ROOT, 'sdk-worker.cjs'),
  timeoutMs: 20000,
})

const status = await bridge.status()
const skip = status.available ? false : `Everything is not answering: ${status.error ?? 'unavailable'}`

describe('live SDK', { skip }, () => {
  it('reports a version and an index size', () => {
    assert.equal(status.available, true)
    assert.match(status.clientVersion, /^\d+\.\d+/)
    assert.ok(status.indexedItems > 0, `indexed ${String(status.indexedItems)} items`)
  })

  it('answers an unfiltered query with absolute paths', async () => {
    const page = await bridge.query({ query: '**', max: 5 })
    assert.equal(page.ok, true)
    assert.ok(page.total > 0)
    assert.ok(page.results.length > 0)
    for (const row of page.results) {
      assert.match(row.path, /^[A-Za-z]:\\/, `not an absolute path: ${row.path}`)
      assert.equal(typeof row.folder, 'boolean')
    }
  })

  it('treats parent: as "this folder\'s direct children"', async () => {
    const seed = await bridge.query({ query: '**', max: 1 })
    assert.equal(seed.ok, true)
    const seedPath = seed.results[0].path
    const parentDir = seedPath.slice(0, Math.max(seedPath.lastIndexOf('\\'), seedPath.lastIndexOf('/')))

    const listing = await bridge.query({ query: `parent:"${parentDir}" **`, max: 20 })
    assert.equal(listing.ok, true)
    assert.ok(listing.results.length > 0, `no children under ${parentDir}`)
    for (const row of listing.results) {
      const rowParent = row.path.slice(0, Math.max(row.path.lastIndexOf('\\'), row.path.lastIndexOf('/')))
      assert.equal(rowParent.toLowerCase(), parentDir.toLowerCase(), `wrong parent for ${row.path}`)
    }
  })

  it('treats path: as a subtree scope', async () => {
    const seed = await bridge.query({ query: '**', max: 1 })
    const seedPath = seed.results[0].path
    const parentDir = seedPath.slice(0, Math.max(seedPath.lastIndexOf('\\'), seedPath.lastIndexOf('/')))

    const scoped = await bridge.query({ query: `path:"${parentDir}" *`, max: 20 })
    assert.equal(scoped.ok, true)
    assert.ok(scoped.results.length > 0, `no rows under ${parentDir}`)
    for (const row of scoped.results) {
      assert.ok(row.path.toLowerCase().startsWith(parentDir.toLowerCase()), `out of scope: ${row.path}`)
    }
  })

  it('returns an empty page rather than an error when a name matches nothing', async () => {
    const page = await bridge.query({ query: '*dsh-everything-definitely-no-such-name-42*', max: 5 })
    assert.equal(page.ok, true)
    assert.equal(page.total, 0)
    assert.deepEqual(page.results, [])
  })
})

/** Release the worker even when a test fails. */
process.on('beforeExit', () => {
  void bridge.dispose()
})
