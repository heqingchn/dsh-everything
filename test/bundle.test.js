/**
 * Package-shape tests: the files a published install must contain, and the two
 * manifests that decide how the Harness mounts this plugin.
 *
 * These catch the failure modes that only appear after `npm pack`: a DLL left out
 * of `files`, a client bundle built as an ES module, or a patch layer that inserts
 * a row but never disables the provider it replaces. All three look fine in
 * `source` and break on install.
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Read one repository file as text. */
async function read(...parts) {
  return await readFile(path.join(ROOT, ...parts), 'utf8')
}

/** Whether a path exists. */
async function exists(...parts) {
  try {
    await stat(path.join(ROOT, ...parts))
    return true
  } catch {
    return false
  }
}

describe('published payload', () => {
  it('ships both compiled halves and the SDK bridge', async () => {
    for (const file of ['lib/index.js', 'lib/pure.js', 'lib/config.js', 'lib/tool.js', 'lib/search.js', 'lib/sdk.js', 'lib/client.cjs.js']) {
      assert.ok(await exists(file), `missing ${file}; run npm run build`)
    }
  })

  it('ships the worker, the vendored FFI module and the SDK DLL', async () => {
    for (const file of [
      'sdk-worker.cjs',
      'native/Everything64.dll',
      'vendor/koffi/index.cjs',
      'vendor/@koromix/koffi-win32-x64/win32_x64/koffi.node',
    ]) {
      assert.ok(await exists(file), `missing ${file}`)
    }
  })

  it('names the browser half to the module loader, not as an ES module', async () => {
    const source = await read('lib', 'client.cjs.js')
    // The Web shell evaluates this file as a plain script; an `export` statement
    // would make it a syntax error in that context.
    assert.ok(source.includes('window.__ModuleLoader__.load({'), 'not a loader registration')
    assert.ok(source.includes("id: 'dsh-everything'"), 'registered under the wrong id')
    assert.ok(!/^export /m.test(source), 'client bundle contains an ES export')
  })
})

describe('package.json', () => {
  it('points the bundle patch at the file that exists', async () => {
    const manifest = JSON.parse(await read('package.json'))
    assert.equal(manifest.name, 'dsh-everything')
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.ok(await exists('cordis.patch.yml'))
  })

  it('declares the two client packages whose slots it fills', async () => {
    const manifest = JSON.parse(await read('package.json'))
    const inject = manifest.dsh?.client?.inject ?? []
    assert.deepEqual(inject, ['@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-client-ui-plugin-manager'])
    assert.equal(manifest.dsh?.client?.platform, 'web')
  })

  it('lists every runtime file in `files`, so a pack keeps them', async () => {
    const manifest = JSON.parse(await read('package.json'))
    for (const entry of ['lib', 'native', 'vendor', 'sdk-worker.cjs', 'assets', 'cordis.patch.yml']) {
      assert.ok(manifest.files.includes(entry), `files is missing ${entry}`)
    }
  })

  it('keeps the Harness packages as peers rather than bundling them', async () => {
    const manifest = JSON.parse(await read('package.json'))
    for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-file-reference', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']) {
      assert.ok(manifest.peerDependencies[peer], `missing peer ${peer}`)
      assert.equal(manifest.dependencies?.[peer], undefined, `${peer} must not be a bundled dependency`)
    }
  })
})

describe('cordis.patch.yml', () => {
  it('inserts its own row and disables the provider it replaces', async () => {
    const patch = await read('cordis.patch.yml')
    assert.match(patch, /- insert:\s*\n\s*- id: file-reference-everything\s*\n\s*name: dsh-everything/)
    assert.match(patch, /- id: file-reference-local\s*\n\s*disabled: true/)
  })
})

describe('sdk worker', () => {
  it('reads its DLL and FFI paths from workerData rather than a fixed location', async () => {
    const worker = await read('sdk-worker.cjs')
    assert.match(worker, /workerData\.dllPath/)
    assert.match(worker, /workerData\.koffiPath/)
    // The SDK's query wait has no timeout of its own; the bridge bounds it.
    assert.match(worker, /Everything_QueryW/)
  })
})
