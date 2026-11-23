/**
 * Unit tests for the `find_files` tool.
 *
 * What is pinned here is the tool's *contract* rather than its plumbing: how a
 * query becomes an Everything term, what a page says about the match set, and
 * which failures become actionable errors. Those are the parts a model depends
 * on, and the parts that go wrong silently — a bad `truncated` flag makes a model
 * report a file as missing, and an unhelpful error makes it retry the same call.
 *
 * The definition is built through `buildFindFilesTool` with a fake host, so the
 * suite needs neither a Harness installation nor an Everything service.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { describe, it } from 'node:test'

// `buildFindFilesTool` reaches for `defineTool` from the Harness, which is not
// installed here. The stub reproduces the one thing the tool relies on — that a
// definition carries its name, parameters, output projection and execute — so the
// suite exercises the real contract without a Harness installation.
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
  MAX_LIMIT,
  DEFAULT_LIMIT,
  buildFindFilesTool,
  clampLimit,
  failureToError,
  renderFindFiles,
  toEntries,
  toolTerm,
} = await import('../lib/tool.js')

describe('toolTerm', () => {
  it('wraps a fragment as a name substring', () => {
    assert.equal(toolTerm('playable'), '*playable*')
  })

  it('treats an empty query or a bare star as "everything in scope"', () => {
    assert.equal(toolTerm(''), '**')
    assert.equal(toolTerm('   '), '**')
    assert.equal(toolTerm('*'), '**')
  })

  it('never emits a space, which would split into two AND-ed terms', () => {
    assert.equal(toolTerm('with space'), '*with?space*')
  })

  it('escapes everything operators, so a name is searched literally', () => {
    assert.equal(toolTerm('a&b'), '*a^&b*')
    assert.equal(toolTerm('a|b'), '*a^|b*')
  })
})

describe('clampLimit', () => {
  it('defaults when the caller names nothing usable', () => {
    assert.equal(clampLimit(undefined), DEFAULT_LIMIT)
    assert.equal(clampLimit(0), DEFAULT_LIMIT)
    assert.equal(clampLimit(-5), DEFAULT_LIMIT)
    assert.equal(clampLimit('nonsense'), DEFAULT_LIMIT)
  })

  it('honours a usable size', () => {
    assert.equal(clampLimit(12), 12)
    assert.equal(clampLimit('12'), 12)
  })

  it('caps at the maximum rather than letting one call bury the caller', () => {
    assert.equal(clampLimit(MAX_LIMIT + 1), MAX_LIMIT)
    assert.equal(clampLimit(100000), MAX_LIMIT)
  })

  it('floors a fractional request', () => {
    assert.equal(clampLimit(12.9), 12)
  })
})

describe('renderFindFiles', () => {
  it('names the scope of an empty answer', () => {
    assert.equal(renderFindFiles({ results: [], count: 0, truncated: false, scope: 'C:\\work' }),
      'No matches under C:\\work.')
    assert.equal(renderFindFiles({ results: [], count: 0, truncated: false }), 'No matches.')
  })

  it('renders one absolute path per line', () => {
    const text = renderFindFiles({
      results: [
        { path: 'C:\\work\\a.ts', name: 'a.ts', directory: false },
        { path: 'C:\\work\\src', name: 'src', directory: true },
      ],
      count: 2,
      truncated: false,
      scope: 'C:\\work',
    })
    assert.match(text, /^2 match\(es\) under C:\\work:/)
    assert.ok(text.includes('C:\\work\\a.ts'))
    assert.ok(text.includes('C:\\work\\src\\'), `folder lost its trailing mark: ${text}`)
  })

  it('does not double the separator Everything already wrote', () => {
    // Everything reports a folder with a trailing backslash; appending another
    // renders `\dir\\`, which reads as a literal two-separator path.
    const text = renderFindFiles({
      results: [{ path: 'C:\\work\\src\\', name: 'src', directory: true }],
      count: 1,
      truncated: false,
    })
    assert.ok(text.endsWith('src\\'), `unexpected tail: ${JSON.stringify(text)}`)
    assert.ok(!text.includes('src\\\\'), `separator was doubled: ${JSON.stringify(text)}`)
  })

  it('states when the page is short of the match set', () => {
    // The single most important line for a model: without it, a truncated page
    // reads as a complete answer and the file looks absent.
    const text = renderFindFiles({
      results: [{ path: 'C:\\work\\a.ts', name: 'a.ts', directory: false }],
      count: 1,
      truncated: true,
    })
    assert.match(text, /more than 1 matched/i)
  })

  it('says nothing about truncation on a complete page', () => {
    const text = renderFindFiles({
      results: [{ path: 'C:\\work\\a.ts', name: 'a.ts', directory: false }],
      count: 1,
      truncated: false,
    })
    assert.doesNotMatch(text, /more than/i)
  })
})

describe('toEntries', () => {
  it('drops a row outside the scope even when the query matched it', () => {
    // `path:` is a substring test, so `C:\work` also matches `C:\workspace\...`.
    const entries = toEntries([
      { path: 'C:\\work\\a.ts', name: 'a.ts', folder: false },
      { path: 'C:\\workspace\\b.ts', name: 'b.ts', folder: false },
    ], 'C:\\work')
    assert.deepEqual(entries.map((entry) => entry.path), ['C:\\work\\a.ts'])
  })

  it('accepts a forward-slash scope and answers in host form', () => {
    const entries = toEntries([{ path: 'C:\\work\\a.ts', name: 'a.ts', folder: false }], 'C:/work')
    assert.equal(entries[0].path, 'C:\\work\\a.ts')
  })

  it('keeps every row when no scope was requested', () => {
    const entries = toEntries([
      { path: 'C:\\work\\a.ts', name: 'a.ts', folder: false },
      { path: 'D:\\other\\b.ts', name: 'b.ts', folder: false },
    ], undefined)
    assert.equal(entries.length, 2)
  })

  it('marks a folder from the row, not from a trailing separator', () => {
    const entries = toEntries([{ path: 'C:\\work\\src', name: 'src', folder: true }], undefined)
    assert.equal(entries[0].directory, true)
  })
})

describe('failureToError', () => {
  it('names the actionable cause when Everything is not running', () => {
    const error = failureToError({ ok: false, errorCode: 'IPC' })
    assert.match(error.message, /Everything is not running/)
    assert.match(error.message, /glob/)
  })

  it('names the alternative on any other failure', () => {
    const error = failureToError({ ok: false, errorCode: 'SDK', error: 'boom', lastError: 7 })
    assert.match(error.message, /boom/)
    assert.match(error.message, /glob/)
  })
})

describe('the tool definition', () => {
  /**
   * A host that answers a fixed page and records each request.
   * @param result - the page or failure to return.
   */
  function fakeHost(result) {
    const calls = []
    return {
      calls,
      exclusions: () => ['!path:*\\Library\\*', '!*.meta'],
      async query(request) {
        calls.push(request)
        return result
      },
    }
  }

  /** Build one successful page from paths. */
  function page(paths, total = paths.length) {
    return {
      ok: true,
      total,
      returned: paths.length,
      databaseLoaded: true,
      results: paths.map((path) => ({
        path,
        name: path.slice(path.lastIndexOf('\\') + 1),
        folder: false,
      })),
    }
  }

  const rows = page(['C:\\work\\a.ts', 'C:\\work\\b.ts'])

  it('registers as find_files', async () => {
    const tool = await buildFindFilesTool(fakeHost(rows))
    assert.equal(tool.name, 'find_files')
  })

  it('declares the parameters a model needs to page and to narrow', async () => {
    const tool = await buildFindFilesTool(fakeHost(rows))
    const parameters = tool.parameters ?? {}
    for (const name of ['query', 'path', 'foldersOnly', 'filesOnly', 'limit']) {
      assert.ok(parameters[name], `missing parameter ${name}`)
    }
  })

  it('passes the term, the page size and the exclusions to the host', async () => {
    const host = fakeHost(rows)
    const tool = await buildFindFilesTool(host)
    await tool.execute({ query: 'alpha', limit: 5 }, { signal: AbortSignal.timeout(1000) })
    const request = host.calls[0]
    assert.equal(request.max, 5)
    assert.ok(request.query.includes('*alpha*'), `no term in ${request.query}`)
    assert.ok(request.query.includes('!path:*\\Library\\*'), `no folder exclusion in ${request.query}`)
    assert.ok(request.query.includes('!*.meta'), `no pattern exclusion in ${request.query}`)
  })

  it('confines the search when a path is given', async () => {
    const host = fakeHost(rows)
    const tool = await buildFindFilesTool(host)
    await tool.execute({ query: 'a', path: 'C:/work' }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[0].query.includes('path:"C:\\work"'), `no scope in ${host.calls[0].query}`)
  })

  it('refuses a call with neither a query nor a path', async () => {
    // Everything would otherwise answer the head of the whole index.
    const tool = await buildFindFilesTool(fakeHost(rows))
    await assert.rejects(
      () => tool.execute({}, { signal: AbortSignal.timeout(1000) }),
      /needs something to find/,
    )
  })

  it('lists a folder when only the path is given', async () => {
    const host = fakeHost(rows)
    const tool = await buildFindFilesTool(host)
    const value = await tool.execute({ path: 'C:/work' }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[0].query.includes('**'), 'a path-only listing must ask for every name')
    assert.equal(value.count, 2)
  })

  it('adds the folder and file filters when asked', async () => {
    const host = fakeHost(rows)
    const tool = await buildFindFilesTool(host)
    await tool.execute({ query: 'a', foldersOnly: true }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[0].query.includes('folder:'))
    await tool.execute({ query: 'a', filesOnly: true }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[1].query.includes('file:'))
  })

  it('reports truncation when the index holds more than this page', async () => {
    const tool = await buildFindFilesTool(fakeHost(page(['C:\\work\\a.ts', 'C:\\work\\b.ts'], 12)))
    const value = await tool.execute({ query: 'a', limit: 2 }, { signal: AbortSignal.timeout(1000) })
    assert.equal(value.count, 2)
    assert.equal(value.truncated, true)
  })

  it('reports a complete page when the match set is fully returned', async () => {
    const tool = await buildFindFilesTool(fakeHost(page(['C:\\work\\a.ts'], 1)))
    const value = await tool.execute({ query: 'a', limit: 50 }, { signal: AbortSignal.timeout(1000) })
    assert.equal(value.truncated, false)
  })

  it('raises an actionable error instead of returning an empty page on failure', async () => {
    const tool = await buildFindFilesTool(fakeHost({ ok: false, errorCode: 'IPC' }))
    await assert.rejects(
      () => tool.execute({ query: 'a' }, { signal: AbortSignal.timeout(1000) }),
      /Everything is not running/,
    )
  })

  it('refuses to start a query after its call was cancelled', async () => {
    const host = fakeHost(rows)
    const tool = await buildFindFilesTool(host)
    const signal = AbortSignal.abort()
    await assert.rejects(
      () => tool.execute({ query: 'a' }, { signal }),
      /cancelled/,
    )
    assert.equal(host.calls.length, 0)
  })

  it('projects a page into the result card metadata', async () => {
    const tool = await buildFindFilesTool(fakeHost(rows))
    const value = await tool.execute({ query: 'a' }, { signal: AbortSignal.timeout(1000) })
    const meta = tool.output.presentationMeta({}, value)
    assert.equal(meta.version, 1)
    assert.equal(meta.shape, 'paths')
    assert.deepEqual(meta.paths, ['C:\\work\\a.ts', 'C:\\work\\b.ts'])
    assert.equal(meta.total, 2)
    assert.equal(meta.truncated, false)
  })

  it('presents the card on replay, and declines malformed metadata', async () => {
    const tool = await buildFindFilesTool(fakeHost(rows))
    const value = await tool.execute({ query: 'a' }, { signal: AbortSignal.timeout(1000) })
    const meta = tool.output.presentationMeta({}, value)

    const card = tool.presentResult({}, { meta })
    assert.equal(card.card, 'search')
    assert.equal(card.shape, 'paths')
    assert.equal(card.paths.length, 2)

    // An older log, or a nested call, carries no projection: fall back to text.
    assert.equal(tool.presentResult({}, {}), undefined)
    assert.equal(tool.presentResult({}, { meta: { paths: 7, truncated: 'yes', total: 1 } }), undefined)
  })

  it('accepts an empty page as a valid card', async () => {
    const tool = await buildFindFilesTool(fakeHost(page([], 0)))
    const value = await tool.execute({ query: 'nothing' }, { signal: AbortSignal.timeout(1000) })
    const card = tool.presentResult({}, { meta: tool.output.presentationMeta({}, value) })
    assert.deepEqual(card.paths, [])
    assert.equal(card.total, 0)
    assert.equal(card.truncated, false)
  })
})
