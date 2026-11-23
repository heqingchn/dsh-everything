/**
 * Unit tests for the `everything_search` tool.
 *
 * The contract pinned here is what the model depends on: which expression reaches
 * the index, what a page says about the match set, and that the configured
 * exclusion lists do **not** silently prune an expression the model wrote.
 *
 * The definition is built through `buildEverythingSearchTool` with a fake host, so
 * the suite needs neither a Harness installation nor an Everything service.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { describe, it } from 'node:test'

// `buildEverythingSearchTool` reaches for `defineTool` from the Harness, which is
// not installed here. The stub reproduces the one thing the tool relies on.
const STUB = `
export function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    execute: options.execute,
    presentCall: options.presentCall,
    presentResult: options.presentResult,
  }
}
`
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === '@deepseek-ai/dsh-tools') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true }
  }
  return next(spec, ctx)
}`))

const {
  SEARCH_TOOL_NAME,
  SORTS,
  buildEverythingSearchTool,
  formatBytes,
  renderSearchResult,
  toSearchEntries,
} = await import('../lib/search.js')

/** Build one successful page from rows. */
function page(rows, total = rows.length) {
  return { ok: true, total, returned: rows.length, databaseLoaded: true, results: rows }
}

/** A host that answers a fixed page and records each request. */
function fakeHost(result) {
  const calls = []
  return {
    calls,
    async query(request) {
      calls.push(request)
      return result
    },
  }
}

describe('SORTS', () => {
  it('matches the SDK sort constants', () => {
    assert.deepEqual(SORTS, {
      name: 1,
      path: 3,
      size: 5,
      'date-created': 11,
      'date-modified': 13,
      recent: 21,
    })
  })
})

describe('formatBytes', () => {
  it('keeps bytes exact and rounds larger units', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2048), '2.0 KB')
    assert.equal(formatBytes(15 * 1024), '15 KB')
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
  })

  it('answers nothing for an unusable value', () => {
    assert.equal(formatBytes(-1), '')
    assert.equal(formatBytes(Number.NaN), '')
  })
})

describe('renderSearchResult', () => {
  it('says when nothing matched, quoting the expression', () => {
    assert.equal(
      renderSearchResult({ query: 'ext:zzz', results: [], count: 0, total: 0, truncated: false }),
      'No files or folders matched "ext:zzz" (0 matches).',
    )
  })

  it('marks folders and adds size and date to files', () => {
    const text = renderSearchResult({
      query: 'ext:ts',
      results: [
        { path: 'C:\\work\\a.ts', name: 'a.ts', directory: false, size: 2048, modified: '2026-11-23T06:00:00.000Z' },
        { path: 'C:\\work\\src', name: 'src', directory: true },
      ],
      count: 2,
      total: 2,
      truncated: false,
    })
    assert.match(text, /Showing 2 of 2 matches for "ext:ts"\./)
    assert.ok(text.includes('- [dir] C:\\work\\src'), text)
    assert.ok(text.includes('- C:\\work\\a.ts (2.0 KB, 2026-11-23T06:00:00.000Z)'), text)
  })

  it('states when the page is short of the match set', () => {
    const text = renderSearchResult({
      query: 'ext:ts',
      results: [{ path: 'C:\\work\\a.ts', name: 'a.ts', directory: false }],
      count: 1,
      total: 40,
      truncated: true,
    })
    assert.match(text, /\(truncated\)/)
    assert.match(text, /more than 1 matched/)
  })

  it('says nothing about truncation on a complete page', () => {
    const text = renderSearchResult({
      query: 'ext:ts',
      results: [{ path: 'C:\\work\\a.ts', name: 'a.ts', directory: false }],
      count: 1,
      total: 1,
      truncated: false,
    })
    assert.doesNotMatch(text, /truncated/)
  })
})

describe('toSearchEntries', () => {
  it('keeps size and modification time, which find_files drops', () => {
    const entries = toSearchEntries([
      { path: 'C:\\work\\a.ts', name: 'a.ts', folder: false, size: 2048, modified: '2026-11-23T06:00:00.000Z' },
    ], undefined)
    assert.equal(entries[0].size, 2048)
    assert.equal(entries[0].modified, '2026-11-23T06:00:00.000Z')
  })

  it('drops a row outside the scope even when the query matched it', () => {
    const entries = toSearchEntries([
      { path: 'C:\\work\\a.ts', name: 'a.ts', folder: false },
      { path: 'C:\\workspace\\b.ts', name: 'b.ts', folder: false },
    ], 'C:\\work')
    assert.deepEqual(entries.map((entry) => entry.path), ['C:\\work\\a.ts'])
  })

  it('omits a size that is not a finite number', () => {
    const entries = toSearchEntries([
      { path: 'C:\\work\\src', name: 'src', folder: true },
    ], undefined)
    assert.equal(entries[0].size, undefined)
  })
})

describe('the tool definition', () => {
  const rows = [
    { path: 'C:\\work\\a.ts', name: 'a.ts', folder: false, size: 1024, modified: '2026-11-23T06:00:00.000Z' },
    { path: 'C:\\work\\src', name: 'src', folder: true },
  ]

  it('registers as everything_search', async () => {
    const tool = await buildEverythingSearchTool(fakeHost(page(rows)))
    assert.equal(tool.name, SEARCH_TOOL_NAME)
  })

  it('declares the expression and paging parameters', async () => {
    const tool = await buildEverythingSearchTool(fakeHost(page(rows)))
    const parameters = tool.parameters ?? {}
    for (const name of ['query', 'path', 'limit', 'sort', 'descending']) {
      assert.ok(parameters[name], `missing parameter ${name}`)
    }
  })

  it('passes the expression through unchanged and asks for the requested sort', async () => {
    const host = fakeHost(page(rows))
    const tool = await buildEverythingSearchTool(host)
    await tool.execute({ query: 'ext:ts', limit: 10, sort: 'size', descending: true }, { signal: AbortSignal.timeout(1000) })
    assert.equal(host.calls[0].query, 'ext:ts')
    assert.equal(host.calls[0].max, 10)
    assert.equal(host.calls[0].sort, SORTS.size + 1)
  })

  it('confines the expression when a path is given', async () => {
    const host = fakeHost(page(rows))
    const tool = await buildEverythingSearchTool(host)
    await tool.execute({ query: 'ext:ts', path: 'C:/work' }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[0].query.includes('path:"C:\\work"'), host.calls[0].query)
  })

  it('does not append the configured exclusion lists', async () => {
    // The caller wrote the expression; pruning it silently would remove rows the
    // model explicitly asked for, with nothing in the result to explain why.
    const host = fakeHost(page(rows))
    const tool = await buildEverythingSearchTool(host)
    await tool.execute({ query: 'folder:Library' }, { signal: AbortSignal.timeout(1000) })
    assert.equal(host.calls[0].query, 'folder:Library')
  })

  it('refuses an empty expression', async () => {
    const tool = await buildEverythingSearchTool(fakeHost(page(rows)))
    await assert.rejects(() => tool.execute({}, { signal: AbortSignal.timeout(1000) }), /needs an expression/)
    await assert.rejects(() => tool.execute({ query: '   ' }, { signal: AbortSignal.timeout(1000) }), /needs an expression/)
  })

  it('refuses to start after its call was cancelled', async () => {
    const host = fakeHost(page(rows))
    const tool = await buildEverythingSearchTool(host)
    await assert.rejects(
      () => tool.execute({ query: 'ext:ts' }, { signal: AbortSignal.abort() }),
      /cancelled/,
    )
    assert.equal(host.calls.length, 0)
  })

  it('raises an actionable error instead of an empty page on failure', async () => {
    const tool = await buildEverythingSearchTool(fakeHost({ ok: false, errorCode: 'IPC' }))
    await assert.rejects(
      () => tool.execute({ query: 'ext:ts' }, { signal: AbortSignal.timeout(1000) }),
      /Everything is not running/,
    )
  })

  it('reports truncation from the index total, not from the page length', async () => {
    const tool = await buildEverythingSearchTool(fakeHost(page(rows, 40)))
    const value = await tool.execute({ query: 'ext:ts', limit: 2 }, { signal: AbortSignal.timeout(1000) })
    assert.equal(value.count, 2)
    assert.equal(value.total, 40)
    assert.equal(value.truncated, true)
  })

  it('projects rows with size and date into the card metadata', async () => {
    const tool = await buildEverythingSearchTool(fakeHost(page(rows)))
    const value = await tool.execute({ query: 'ext:ts' }, { signal: AbortSignal.timeout(1000) })
    const meta = tool.output.presentationMeta({}, value)
    assert.equal(meta.version, 1)
    assert.equal(meta.shape, 'entries')
    assert.equal(meta.rows.length, 2)
    assert.equal(meta.rows[0].size, 1024)
    assert.equal(meta.rows[0].modified, '2026-11-23T06:00:00.000Z')
    assert.equal(meta.total, 2)
  })

  it('presents the generic search card on replay, and declines malformed metadata', async () => {
    const tool = await buildEverythingSearchTool(fakeHost(page(rows)))
    const value = await tool.execute({ query: 'ext:ts' }, { signal: AbortSignal.timeout(1000) })
    const card = tool.presentResult({}, { meta: tool.output.presentationMeta({}, value) })
    assert.equal(card.card, 'search')
    assert.equal(card.shape, 'paths')
    assert.deepEqual(card.paths, ['C:\\work\\a.ts', 'C:\\work\\src'])

    assert.equal(tool.presentResult({}, {}), undefined)
    assert.equal(tool.presentResult({}, { meta: { shape: 'paths', rows: [] } }), undefined)
    assert.equal(tool.presentResult({}, { meta: { shape: 'entries', rows: [{}], truncated: false, total: 1 } }), undefined)
  })
})
