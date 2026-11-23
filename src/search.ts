/**
 * The `everything_search` tool: Everything's query syntax, as a model tool.
 *
 * `find_files` answers "where is the file called X". It deliberately accepts a
 * plain name fragment and nothing else, because that is the common case and an
 * expression dialect would leak into every call. This tool is the other half:
 * filters a name lookup cannot express — `ext:`, `size:`, `dm:`, `folder:`, `!`,
 * `|`, `regex:` — answered from the same index.
 *
 * ## Why the exclusion lists do not apply here
 *
 * `@` completion and `find_files` hide the folders configured in the plugin card,
 * because a human's completion box should not fill with generated trees. This tool
 * is different: the caller *wrote* the expression. Silently appending
 * `!path:*\Library\*` would remove rows the model explicitly asked for, and the
 * model would have no way to know why. A model that wants a folder excluded can
 * write `!path:` itself.
 *
 * ## Why `regex:` is allowed
 *
 * A `regex:` term makes Everything scan the whole index instead of using the name
 * table, which is the difference between tens of milliseconds and seconds to
 * minutes. It stays available because it is sometimes the only way to express a
 * filter, and the SDK bridge already bounds every query with `queryTimeoutMs`. The
 * tool description tells the model it is slow and to prefer the indexed filters.
 *
 * @module dsh-everything/search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { formatBytes, type SdkFailure, type SdkQuery, type SdkResult, type SdkRow } from './protocol.js'
import { pathTerm } from './query.js'
import { MAX_LIMIT, clampLimit, DEFAULT_LIMIT, failureToError } from './tool.js'

/** Tool name, as the model sees it. */
export const SEARCH_TOOL_NAME = 'everything_search'

/**
 * System-prompt guidance for the syntax tool.
 *
 * Appended to the `find_files` guidance whenever this tool registers, so the model
 * reads one decision — "where do I look for this file" — instead of two unrelated
 * feature blurbs. It names the common filters explicitly: a model that has never
 * seen Everything's dialect will otherwise fall back to `glob`.
 */
export const EVERYTHING_SYNTAX_PROMPT = `\`everything_search\` takes Everything's own query syntax when a name is not enough: \`ext:ts\`, \`size:>100kb\`, \`dm:today\`, \`dm:>2026-11-01\`, \`folder:node_modules\`, \`file:*.log\`; space is AND, \`|\` is OR, a leading \`!\` excludes. \`regex:\` works but scans the whole index and can take seconds — prefer the indexed filters.

To find files changed today, above a size, or of one extension, use this tool with \`dm:\`/\`size:\`/\`ext:\` — do not walk the tree with shell commands. Combine several folders with \`|\` (\`path:"A" | path:"B"\`). For newest first use \`sort:"date-modified"\` with \`descending:true\`; \`recent\` sorts by the filesystem's recently-changed time, not by modification time.

Use \`find_files\` for a plain name lookup; use this tool when those filters are what you mean.`

/**
 * Everything sort constants (ascending; descending is the next value).
 *
 * Duplicated from the worker protocol rather than imported, because the worker is
 * a CommonJS script outside this module graph.
 */
export const SORTS = {
  name: 1,
  path: 3,
  size: 5,
  'date-created': 11,
  'date-modified': 13,
  recent: 21,
} as const

/** One row of the tool's result. */
export interface SearchEntry {
  /** Absolute path, in host form. */
  path: string
  /** Final path segment. */
  name: string
  /** Whether the entry is a folder. */
  directory: boolean
  /** File size in bytes; absent for folders. */
  size?: number
  /** ISO 8601 modification time, when Everything reported one. */
  modified?: string
}

/** The tool's structured value. */
export interface SearchResult {
  /** The expression that was run, echoed back. */
  query: string
  /** The entries on this page. */
  results: SearchEntry[]
  /** How many entries this page holds. */
  count: number
  /** How many entries the index holds for this expression. */
  total: number
  /** Whether more entries matched than this page returned. */
  truncated: boolean
  /** The folder the search was confined to, when one was requested. */
  scope?: string
}

/**
 * Render a byte count in the units the model can compare at a glance.
 *
 * Re-exported from {@link formatBytes} in `protocol.ts`, where it lives because the
 * browser card needs the same formatter without importing this module.
 */
export { formatBytes }

/**
 * Render the result for the model.
 *
 * Same contract as `renderFindFiles`: the closing line states how the page relates
 * to the match set, because a model that cannot tell a complete answer from a
 * truncated one will report a missing file. A folder is marked `[dir]` so a
 * directory and a file of the same name are distinguishable.
 *
 * @param value - the tool's structured value.
 * @returns the text block handed to the model.
 */
export function renderSearchResult(value: SearchResult): string {
  const expression = JSON.stringify(value.query)
  if (value.results.length === 0) {
    return `No files or folders matched ${expression} (0 matches).`
  }
  const header = `Showing ${String(value.count)} of ${String(value.total)} match${value.total === 1 ? '' : 'es'} for ${expression}${value.truncated ? ' (truncated)' : ''}.`
  const lines = [header]
  for (const entry of value.results) {
    const meta: string[] = []
    const size = entry.size === undefined ? '' : formatBytes(entry.size)
    if (size !== '') meta.push(size)
    if (entry.modified !== undefined) meta.push(entry.modified)
    const suffix = meta.length === 0 ? '' : ` (${meta.join(', ')})`
    if (entry.directory) {
      lines.push(`- [dir] ${entry.path}${suffix}`)
      continue
    }
    lines.push(`- ${entry.path}${suffix}`)
  }
  if (value.truncated) {
    lines.push(`(more than ${String(value.results.length)} matched; raise \`limit\`, or narrow the expression)`)
  }
  return lines.join('\n')
}

/**
 * Turn queried rows into this tool's entries, dropping anything outside `scope`.
 *
 * The scope re-check is not redundant with the `path:` term: that term is a
 * substring test, so `path:C:\work` also matches `C:\workspace\...`.
 *
 * @param rows - rows reported by Everything.
 * @param scope - the normalised folder the query was confined to, if any.
 * @returns entries, in the order Everything returned them.
 */
export function toSearchEntries(rows: readonly SdkRow[], scope: string | undefined): SearchEntry[] {
  const entries: SearchEntry[] = []
  const root = scope === undefined ? undefined : scope.replaceAll('/', '\\').replace(/\\+$/, '')
  const prefix = root === undefined ? undefined : `${root}\\`.toLowerCase()

  for (const row of rows) {
    const absolute = row.path.replaceAll('/', '\\')
    if (root !== undefined && prefix !== undefined) {
      const lowered = absolute.toLowerCase()
      if (lowered !== root.toLowerCase() && !lowered.startsWith(prefix)) continue
    }
    const trimmed = absolute.replace(/\\+$/, '')
    const index = trimmed.lastIndexOf('\\')
    if (index < 0) continue
    const name = trimmed.slice(index + 1)
    if (name === '') continue
    entries.push({
      path: absolute,
      name,
      directory: row.folder,
      ...(typeof row.size === 'number' && Number.isFinite(row.size) ? { size: row.size } : {}),
      ...(typeof row.modified === 'string' && row.modified !== '' ? { modified: row.modified } : {}),
    })
  }
  return entries
}

/** What the tool needs from the plugin that owns it. */
export interface EverythingSearchHost {
  /** Run one expression against the SDK bridge. */
  query(request: SdkQuery): Promise<SdkResult | SdkFailure>
}

/**
 * Build the tool definition.
 *
 * Kept as a factory over a host accessor rather than closing over the service, so
 * the definition can be exercised in the test suite without a Harness
 * installation: the host supplies the query, the tool owns the contract.
 *
 * @param host - the owning plugin's query seam.
 * @returns a registry-ready tool definition.
 */
export function buildEverythingSearchTool(host: EverythingSearchHost) {
  const sortNames = Object.keys(SORTS)
  return defineTool({
    name: SEARCH_TOOL_NAME,
    description:
      'Search the local Everything index with its own query syntax: filter by extension, size, date or folder; '
      + 'combine terms with AND/OR/NOT. Use it when a plain name lookup is not enough — `find_files` is faster for that. '
      + 'Names and metadata only, never contents.',
    parameters: {
      query: {
        type: 'string',
        description:
          'Everything expression, e.g. "ext:ts size:>100kb dm:today". Space is AND, | is OR, a leading ! excludes.',
        required: true,
      },
      path: {
        type: 'string',
        description:
          'Absolute folder to confine the search to, including subfolders. Omit to search every indexed drive.',
      },
      limit: {
        type: 'integer',
        description: `Maximum entries (default ${String(DEFAULT_LIMIT)}, at most ${String(MAX_LIMIT)}).`,
      },
      sort: {
        type: 'string',
        enum: sortNames,
        description: 'Sort order; defaults to name.',
      },
      descending: {
        type: 'boolean',
        description: 'Reverse the sort order.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                name: { type: 'string', required: true },
                directory: { type: 'boolean', required: true },
                size: { type: 'integer' },
                modified: { type: 'string' },
              },
            },
          },
          count: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          scope: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value as SearchResult) }],
      // The Web card cannot be rebuilt from the rendered text, so the page is
      // projected into the metadata the card narrows back. Rows are capped to keep
      // the Session log small; the model-facing text still lists every row.
      presentationMeta: (_args, value) => {
        const page = value as SearchResult
        const rows = page.results.slice(0, 100).map((entry) => ({
          path: entry.path,
          name: entry.name,
          directory: entry.directory,
          ...(entry.size === undefined ? {} : { size: entry.size }),
          ...(entry.modified === undefined ? {} : { modified: entry.modified }),
        }))
        return {
          version: 1,
          shape: 'entries',
          rows,
          truncated: page.truncated,
          total: page.total,
        }
      },
    },
    async execute(args, exec) {
      const expression = typeof args.query === 'string' ? args.query.trim() : ''
      if (expression === '') {
        throw new Error(
          'everything_search needs an expression: pass `query`, e.g. "ext:ts size:>100kb" or "file:*.log path:C:\\\\work".',
        )
      }
      if (exec.signal.aborted) throw new Error('everything_search was cancelled.')

      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      const scope = requestedPath === ''
        ? undefined
        : requestedPath.replaceAll('/', '\\').replace(/\\+$/, '')
      const limit = clampLimit(args.limit)
      const sortName = typeof args.sort === 'string' && Object.hasOwn(SORTS, args.sort) ? args.sort : 'name'
      const sort = SORTS[sortName as keyof typeof SORTS] + (args.descending === true ? 1 : 0)

      const query = scope === undefined ? expression : `${pathTerm(scope)} ${expression}`
      const rows = await host.query({ query, max: limit, sort })
      if (!rows.ok) throw failureToError(rows)

      const entries = toSearchEntries(rows.results, scope).slice(0, limit)
      const result: SearchResult = {
        query: expression,
        results: entries,
        count: entries.length,
        total: rows.total,
        truncated: rows.total > entries.length,
        ...(scope === undefined ? {} : { scope }),
      }
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Search files: ${typeof args.query === 'string' ? args.query : ''}`,
      kind: 'search',
      rawInput: args,
    }),
    // Narrow the projected page back into the generic search card. Malformed or
    // absent metadata returns undefined so the card falls back to the rendered
    // text instead of throwing during replay.
    presentResult: (_args, result) => {
      const meta = result?.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
      const { shape, rows, truncated, total } = meta as { shape?: unknown; rows?: unknown; truncated?: unknown; total?: unknown }
      if (shape !== 'entries' || !Array.isArray(rows)) return undefined
      if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
      const paths: string[] = []
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) return undefined
        const path = (row as { path?: unknown }).path
        if (typeof path !== 'string') return undefined
        paths.push(path)
      }
      return {
        card: 'search',
        shape: 'paths',
        title: `everything_search: ${String(paths.length)} path(s)`,
        paths,
        truncated,
        total,
      }
    },
  })
}

/**
 * Turn a failure into the error the model should read.
 *
 * Re-exported so callers of this module do not have to import `tool.ts` as well.
 */
export { failureToError }
