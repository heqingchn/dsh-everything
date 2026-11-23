/**
 * Render both cards the way the browser half does, and assert on what a user
 * would actually see.
 *
 * This exists because every earlier test asked a helper a question while the page
 * stayed broken: the card was registered, the slot key was right, the settings
 * scope resolved — and the page rendered a column of empty boxes, because
 * `ctx.locale.bind()` returns a lookup *function* and its result was being read as
 * a table of strings. Nothing in the suite looked at a rendered tree.
 *
 * So this expands the components and checks the captions, which is coarse on
 * purpose: if a label, a path or a count goes missing again, this fails regardless
 * of which layer dropped it.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import vm from 'node:vm'

const BUNDLE = fileURLToPath(new URL('../lib/client.cjs.js', import.meta.url))

/**
 * Expand a rendered tree to the plain-text strings a user would read.
 *
 * Function components are called immediately by the `createElement` stub below,
 * so this only has to walk the resulting element objects.
 *
 * @param node - any node the stub produced.
 * @param out - accumulator.
 * @returns the collected strings.
 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'object' && 'props' in node) {
    texts(node.props?.children, out)
    return out
  }
  out.push(String(node))
  return out
}

/**
 * Collect the `value` prop of every control in a rendered tree.
 *
 * A textarea's text is a prop rather than a child, so {@link texts} cannot see it;
 * this is what asserts that a stored exclusion list actually reached the control.
 *
 * @param node - any node the stub produced.
 * @param out - accumulator.
 * @returns the collected string values.
 */
function controlValues(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) controlValues(child, out)
    return out
  }
  if (typeof node === 'object' && 'props' in node) {
    if (typeof node.props?.value === 'string') out.push(node.props.value)
    controlValues(node.props?.children, out)
    return out
  }
  return out
}

// Loaded at module scope, not in a `before` hook: `describe` bodies run before any
// hook, so a skip decision made from a hook would always say "not built".
let client
let loadError
try {
  const source = await readFile(BUNDLE, 'utf8')
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { registered = definition } } },
    console,
    // The cards pick their copy from the browser language; pin it so the assertions
    // below are about the card, not about the machine's locale.
    navigator: { language: 'zh-CN' },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.cjs.js' })
  client = registered.factory((specifier) => {
    if (specifier !== 'react') throw new Error(`unexpected require: ${specifier}`)
    return {
      // Call function components immediately, so the tree is plain data.
      createElement: (type, props, ...children) =>
        typeof type === 'function'
          ? type({ ...(props ?? {}), children: children.flat() })
          : { type, props: { ...(props ?? {}), children: children.flat() } },
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useMemo: (factory) => factory(),
      useEffect: () => {},
      Component: class Component {
        constructor(props) {
          this.props = props
          this.state = {}
        }

        setState(next) {
          this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
        }
      },
    }
  })
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error)
}

/** A settings scope shaped like `configForms.get(ns)` answers. */
const SCOPE = {
  getSnapshot: () => ({
    status: 'ready',
    writable: true,
    value: {
      excludeInQuery: ['Library'],
      excludeFilePatterns: ['*.meta'],
      excludedDirectories: ['.git', 'node_modules'],
    },
  }),
  subscribe: () => () => {},
  set: () => Promise.resolve(true),
}

/**
 * Run the browser half and capture what it registers.
 * @param options - which services exist and what locale the host reports.
 * @returns the registered slots.
 */
function register({ language = 'zh-CN', withForms = true } = {}) {
  const slots = []
  client.apply({
    locale: { getSnapshot: () => ({ active: { id: language } }) },
    get: (name) => (name === 'configForms' && withForms ? { get: () => SCOPE } : undefined),
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, component) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    effect: (callback) => callback(),
  })
  return slots
}

describe('client bundle', () => {
  it('loads and exposes apply', () => {
    assert.equal(loadError, undefined, `bundle failed to load: ${loadError}`)
    assert.equal(typeof client?.apply, 'function')
  })
})

describe('slot registration', () => {
  it('registers the configuration card under both bundle and row keys', () => {
    const slots = register()
    const configs = slots.filter((slot) => slot.options.name.startsWith('plugins.'))
    const keys = configs.map((slot) => slot.options.key).sort()
    assert.deepEqual(keys, ['dsh-everything', 'dsh-everything#file-reference-everything'])
  })

  it('registers a result card for each wire tool name', () => {
    const slots = register()
    const toolview = slots.filter((slot) => slot.options.name === 'tool.call.toolview')
    assert.deepEqual(toolview.map((slot) => slot.options.key).sort(), ['everything_search', 'find_files'])
  })

  it('still registers the result cards when no settings service exists', () => {
    // A missing `configForms` must not cost the transcript cards.
    const slots = register({ withForms: false })
    assert.equal(slots.filter((slot) => slot.options.name === 'tool.call.toolview').length, 2)
  })
})

describe('configuration card', () => {
  it('renders the three exclusion controls with the stored values', () => {
    const tree = client.EverythingCard({ t: client.copyFor('zh'), settingsScope: SCOPE })
    const rendered = texts(tree)
    for (const expected of ['排除文件夹', '排除文件', '仅在结果里排除', '保存', '放弃修改']) {
      assert.ok(rendered.some((text) => text === expected || text.includes(expected)), `missing ${expected}`)
    }
    const values = controlValues(tree)
    assert.ok(values.includes('Library'), `stored folder pattern did not reach the control: ${values.join(' | ')}`)
    assert.ok(values.includes('*.meta'), `stored file pattern did not reach the control: ${values.join(' | ')}`)
  })

  it('says so when this deployment serves no settings scope', () => {
    const rendered = texts(client.EverythingCard({ t: client.copyFor('zh'), settingsScope: undefined }))
    assert.ok(rendered.some((text) => text.includes('该插件当前未加载')), `unexpected: ${rendered.join(' | ')}`)
  })

  it('names the empty state when nothing is excluded', () => {
    const emptyScope = {
      ...SCOPE,
      getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
    }
    const rendered = texts(client.EverythingCard({ t: client.copyFor('zh'), settingsScope: emptyScope }))
    assert.ok(rendered.some((text) => text.includes('当前没有排除项')))
  })
})

describe('describeStatus', () => {
  const copy = () => client.copyFor('zh')

  it('says nothing while the first probe is still in flight', () => {
    assert.equal(client.describeStatus({ failed: false, checking: true }, copy()), '')
  })

  it('distinguishes an unanswered host route from a missing client', () => {
    assert.match(client.describeStatus({ failed: true, checking: false }, copy()), /无法读取状态/)
    assert.match(
      client.describeStatus({ failed: false, checking: false, status: { available: false, sdkDll: 'x.dll', error: 'no ipc' } }, copy()),
      /未运行/,
    )
  })

  it('reports version, index size and the DLL when the client answers', () => {
    const line = client.describeStatus({
      failed: false,
      checking: false,
      status: { available: true, clientVersion: '1.4.1.1028', indexedItems: 1234, databaseLoaded: true, sdkDll: 'C:\\x.dll' },
    }, copy())
    assert.match(line, /1\.4\.1\.1028/)
    assert.match(line, /1,234/)
    assert.match(line, /C:\\x\.dll/)
  })
})

describe('normalizeSearchMeta', () => {
  it('accepts the projection this plugin writes', () => {
    const model = client.normalizeSearchMeta({
      version: 1,
      shape: 'paths',
      paths: ['C:\\work\\a.ts', 'C:\\work\\src\\'],
      truncated: true,
      total: 9,
    })
    assert.equal(model.rows.length, 2)
    assert.equal(model.rows[1].folder, true)
    assert.equal(model.total, 9)
    assert.equal(model.truncated, true)
  })

  it('declines metadata from another writer or an older log', () => {
    assert.equal(client.normalizeSearchMeta(undefined), null)
    assert.equal(client.normalizeSearchMeta({ shape: 'paths', paths: [] }), null)
    assert.equal(client.normalizeSearchMeta({ version: 1, shape: 'matches', paths: [] }), null)
    assert.equal(client.normalizeSearchMeta({ version: 1, shape: 'paths' }), null)
  })
})

describe('result card', () => {
  /** A settled call carrying the given metadata and raw arguments. */
  const block = (meta, argsRaw) => ({ meta, call: { argsRaw: JSON.stringify(argsRaw) } })

  it('shows the query and the returned/total count while collapsed', () => {
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: block({ version: 1, shape: 'paths', paths: ['C:\\a\\x.ts'], truncated: false, total: 3 }, { query: 'x' }),
    }))
    assert.ok(rendered.includes('find_files'))
    assert.ok(rendered.includes('x'), `query did not render: ${rendered.join(' | ')}`)
    assert.ok(rendered.includes('1/3'), `count did not render: ${rendered.join(' | ')}`)
  })

  it('lists one line per path when expanded', () => {
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: block({
        version: 1,
        shape: 'paths',
        paths: ['C:\\work\\a.ts', 'C:\\work\\src\\'],
        truncated: false,
        total: 2,
      }, { query: 'a' }),
      useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    }))
    assert.ok(rendered.includes('a.ts'), `missing file row: ${rendered.join(' | ')}`)
    assert.ok(rendered.includes('src\\'), `missing folder row: ${rendered.join(' | ')}`)
  })

  it('shows size and modification time for a syntax result', () => {
    // The `entries` projection is what `everything_search` writes; the `paths`
    // projection above carries neither field.
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: block({
        version: 1,
        shape: 'entries',
        rows: [{ path: 'C:\\work\\a.ts', name: 'a.ts', directory: false, size: 2048, modified: '2026-11-23T06:00:00.000Z' }],
        truncated: false,
        total: 1,
      }, { query: 'ext:ts' }),
      useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    }))
    assert.ok(rendered.some((text) => text.includes('2.0 KB')), `no size: ${rendered.join(' | ')}`)
    assert.ok(rendered.some((text) => /2026/.test(text)), `no date: ${rendered.join(' | ')}`)
  })

  it('falls back to this module\'s copy when the shell lookup has no dictionary', () => {
    // The shell hands cards a locale-bound lookup, but this bundle registers no
    // locale dictionary, so that lookup answers the key itself. Preferring it
    // unconditionally rendered `resultMatches` on screen.
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: block({ version: 1, shape: 'paths', paths: ['C:\\a\\x.ts'], truncated: false, total: 3 }, { query: 'x' }),
      t: (key) => key,
      useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    }))
    assert.ok(rendered.some((text) => text.includes('项匹配')), `no translated count: ${rendered.join(' | ')}`)
    assert.ok(!rendered.includes('resultMatches'), `raw key leaked: ${rendered.join(' | ')}`)
  })

  it('uses the shell lookup when it does answer', () => {
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: block({ version: 1, shape: 'paths', paths: ['C:\\a\\x.ts'], truncated: false, total: 3 }, { query: 'x' }),
      t: (key) => (key === 'resultMatches' ? 'CUSTOM MATCHES' : key),
      useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    }))
    assert.ok(rendered.some((text) => text.includes('CUSTOM MATCHES')), `shell copy ignored: ${rendered.join(' | ')}`)
  })

  it('shows the scope on a path-only listing, which carries no query', () => {
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: block({
        version: 1,
        shape: 'paths',
        paths: ['C:\\work\\a.ts'],
        truncated: false,
        total: 1,
      }, { path: 'C:\\work' }),
    }))
    assert.ok(rendered.includes('C:\\work'), `scope did not render: ${rendered.join(' | ')}`)
  })

  it('localizes the inspect affordance', () => {
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: block({ version: 1, shape: 'paths', paths: ['C:\\a\\x.ts'], truncated: false, total: 1 }, { query: 'x' }),
      inspect: () => {},
      useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    }))
    assert.ok(rendered.includes('检查调用'), `inspect not localized: ${rendered.join(' | ')}`)
  })

  it('names the missing Everything client on a failure', () => {
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: {
        isError: true,
        content: [{ type: 'text', text: 'find_files cannot run: Everything is not running, so its index cannot be queried.' }],
      },
      useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    }))
    assert.ok(rendered.some((text) => text.includes('Everything 未运行')), `unexpected: ${rendered.join(' | ')}`)
  })

  it('falls back to the recorded text for metadata it cannot read', () => {
    const rendered = texts(client.FindFilesCard({
      phase: 'result',
      block: { meta: { shape: 'foreign' }, content: [{ type: 'text', text: 'No matches.' }] },
      useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    }))
    assert.ok(rendered.some((text) => text.includes('No matches.')))
  })
})
