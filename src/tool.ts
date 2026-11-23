/**
 * The `find_files` model tool: Everything's index, as a tool the agent can call.
 *
 * ## Why a tool as well as the `@` provider
 *
 * The `@` provider answers a *human* typing in the composer. It cannot help the
 * agent, which resolves paths itself: without this tool the model's only options
 * are `glob`, which walks the tree, and shell commands, which walk it worse. On a
 * large workspace neither reaches the sources before its budget runs out.
 * Everything already holds that index, so the same lookup that makes `@` fast
 * makes the tool fast.
 *
 * ## Why it is not a wrapper over the provider
 *
 * The provider is deliberately *narrow*: it is scoped to one working directory,
 * ranks for human keystrokes, and answers paths relative to that root. A model
 * asking "where is this file" wants the opposite on all three counts — it may
 * search any indexed drive, it wants every match rather than the twenty most
 * typeable, and it needs absolute paths it can hand to `read`. Sharing the
 * low-level query while keeping the selection logic apart is what lets each
 * answer its own caller instead of compromising on one.
 *
 * ## Safety of scope
 *
 * This tool searches the whole index, on purpose. The provider's scope
 * confinement exists because a completion box must never surface a file from a
 * sibling checkout the user cannot see; a model asked to find a file has the
 * opposite need, and confining it would make the tool useless on multi-repo
 * machines. It returns absolute paths, and the model decides what to read.
 *
 * @module dsh-everything/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { failureMessage, type SdkFailure, type SdkQuery, type SdkResult, type SdkRow } from './protocol.js'
import { contiguousTerm, pathTerm } from './query.js'

/** Tool name, as the model sees it. */
export const TOOL_NAME = 'find_files'

/**
 * System-prompt guidance that teaches the model when to reach for the tool.
 *
 * A tool description alone is not enough. The model sees `glob`, `grep` and
 * `find_files` side by side and picks by habit, which in practice means `glob` —
 * the one that walks the tree and gives up. This section is the missing sentence:
 * *which* of the three to use for *which* question. It is installed
 * unconditionally whenever the tool registers, because a user should never have
 * to know that a prompt needs configuring for the tool to be found at all.
 */
export const FILE_SEARCH_PROMPT = `\`find_files\` answers "where is this file" from Everything's live machine-wide index and returns absolute paths. It takes a plain file or folder name, or any contiguous fragment of one, with optional \`*\` and \`?\` wildcards — not a query dialect — and is the fastest way to locate a file by name, including files outside the workspace or under folders a workspace walk would skip.

It searches names only, never contents: use \`grep\` for contents. Pass \`path\` to confine the search to one folder and its subfolders, and \`limit\` to page; when the result says more matched, raise \`limit\` or narrow the query rather than assuming the list is complete.

\`glob\` only walks the workspace and honors ignore rules. If the file may be outside the workspace, or you are matching a name rather than a directory path, use \`find_files\`.`

/** Most matches one call may return. Past this the page buries the caller. */
export const MAX_LIMIT = 500

/** Default page size when the caller names none. */
export const DEFAULT_LIMIT = 50

/** One row of the tool's result. */
export interface FoundEntry {
  /** Absolute path, in host form. */
  path: string
  /** Final path segment. */
  name: string
  /** Whether the entry is a folder. */
  directory: boolean
}

/** The tool's structured value. */
export interface FindFilesResult {
  /** The entries on this page. */
  results: FoundEntry[]
  /** How many entries this page holds. */
  count: number
  /** Whether more entries matched than this page returned. */
  truncated: boolean
  /** The folder the search was confined to, when one was requested. */
  scope?: string
}

/**
 * Build the Everything term for a tool query.
 *
 * The model writes a plain file name or fragment, not Everything syntax: this
 * tool is for "find this file", and exposing the query dialect would invite
 * `ext:`/`dm:` expressions whose interactions with the search path and the
 * exclusions are a whole other surface. The term is therefore a literal substring
 * of the name.
 *
 * A query of `*` or empty means "everything in scope", which is what a listing of
 * a folder asks for.
 *
 * @param query - the caller's text.
 * @returns an Everything term.
 */
export function toolTerm(query: string): string {
  const trimmed = query.trim()
  if (trimmed === '' || trimmed === '*') return '**'
  return contiguousTerm(trimmed)
}

/**
 * Clamp a requested page size into the tool's bounds.
 * @param value - the caller's `limit`, or undefined.
 * @returns a positive integer no larger than {@link MAX_LIMIT}.
 */
export function clampLimit(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(numeric), MAX_LIMIT)
}

/**
 * Render the result for the model.
 *
 * One absolute path per line, and a closing line that says how the page relates
 * to the match set — a model that cannot tell "these are all of them" from "these
 * are the first fifty" will confidently report a missing file.
 *
 * @param value - the tool's structured value.
 * @returns the text block handed to the model.
 */
export function renderFindFiles(value: FindFilesResult): string {
  if (value.results.length === 0) {
    return value.scope === undefined ? 'No matches.' : `No matches under ${value.scope}.`
  }
  const lines = value.results.map((entry) => {
    // Everything already reports a folder with a trailing separator; adding
    // another would render `\dir\\`. One trailing mark is what distinguishes a
    // folder from a file of the same name, so it is kept either way.
    if (!entry.directory) return entry.path
    return entry.path.endsWith('\\') ? entry.path : `${entry.path}\\`
  })
  const head = `${String(value.count)} match(es)${value.scope === undefined ? '' : ` under ${value.scope}`}:`
  const tail = value.truncated
    ? `\n(more than ${String(value.count)} matched; raise \`limit\`, or narrow \`query\`/\`path\`)`
    : ''
  return `${head}\n${lines.join('\n')}${tail}`
}

/**
 * Turn queried rows into the tool's entries, dropping anything outside `scope`.
 *
 * The scope re-check is not redundant with the SDK's search path: the path is a
 * query hint, and a row whose path merely contains the scope string would
 * otherwise ride along.
 *
 * @param rows - rows reported by Everything.
 * @param scope - the normalised folder the query was confined to, if any.
 * @returns entries, in the order Everything returned them.
 */
export function toEntries(rows: readonly SdkRow[], scope: string | undefined): FoundEntry[] {
  const entries: FoundEntry[] = []
  // Normalise here rather than trusting the caller: a forward-slash scope would
  // fail every comparison, because Everything answers in backslashes.
  const root = scope === undefined ? undefined : scope.replaceAll('/', '\\').replace(/\\+$/, '')
  const prefix = root === undefined ? undefined : `${root}\\`.toLowerCase()

  for (const row of rows) {
    const absolute = row.path.replaceAll('/', '\\')
    if (root !== undefined && prefix !== undefined) {
      const lowered = absolute.toLowerCase()
      const inside = lowered === root.toLowerCase() || lowered.startsWith(prefix)
      if (!inside) continue
    }
    const trimmed = absolute.replace(/\\+$/, '')
    const index = trimmed.lastIndexOf('\\')
    if (index < 0) continue
    const name = trimmed.slice(index + 1)
    if (name === '') continue
    entries.push({ path: absolute, name, directory: row.folder })
  }
  return entries
}

/** What the tool needs from the plugin that owns it. */
export interface FindFilesHost {
  /**
   * Run one query against the SDK bridge.
   *
   * The exclusions are applied by the host because both the `@` provider and this
   * tool must hide the same generated trees: a model searching for a source file
   * should not have to wade through what a human's completion already prunes.
   */
  query(request: SdkQuery): Promise<SdkResult | SdkFailure>
  /** Everything terms that prune the configured exclusion lists. */
  exclusions(): string[]
}

/**
 * Build the tool definition.
 *
 * Kept as a factory over a host accessor rather than closing over the service,
 * so the definition can be exercised in the test suite without a Harness
 * installation: the host supplies the query and exclusions, the tool owns the
 * contract.
 *
 * @param host - the owning plugin's query seam and exclusion settings.
 * @returns a registry-ready tool definition.
 */
export function buildFindFilesTool(host: FindFilesHost) {
  return defineTool({
    name: TOOL_NAME,
    description:
      'Find files or folders anywhere on this machine by name, from the local Everything index. '
      + 'Takes a plain name or fragment — no query syntax. Names only, never contents; use grep for contents.',
    parameters: {
      query: {
        type: 'string',
        description:
          'File or folder name, or any contiguous fragment of one. `*` and `?` are wildcards; use `*` or omit it to list a folder.',
      },
      path: {
        type: 'string',
        description:
          'Absolute folder to confine the search to, including subfolders. Omit to search every indexed drive.',
      },
      foldersOnly: {
        type: 'boolean',
        description: 'Return only folders.',
      },
      filesOnly: {
        type: 'boolean',
        description: 'Return only files.',
      },
      limit: {
        type: 'integer',
        description: `Maximum entries (default ${String(DEFAULT_LIMIT)}, at most ${String(MAX_LIMIT)}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
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
              },
            },
          },
          count: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          scope: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderFindFiles(value as FindFilesResult) }],
      // The Web card cannot be rebuilt from the rendered text, so the page is
      // projected into the metadata the presenter narrows back.
      presentationMeta: (_args, value) => {
        const page = value as FindFilesResult
        return {
          version: 1,
          shape: 'paths',
          paths: page.results.map((entry) => entry.path),
          truncated: page.truncated,
          total: page.count,
        }
      },
    },
    async execute(args, exec) {
      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      const scope = requestedPath === ''
        ? undefined
        : requestedPath.replaceAll('/', '\\').replace(/\\+$/, '')
      const queryText = typeof args.query === 'string' ? args.query.trim() : ''

      if (scope === undefined && queryText === '') {
        // Without either, Everything answers the head of the whole index, which
        // is never what the caller meant and costs a full page of context.
        throw new Error(
          'find_files needs something to find: pass `query` (a file or folder name), or `path` alone to list a folder.',
        )
      }

      // The SDK call cannot be interrupted mid-flight (it runs in the worker), so
      // cancellation is honoured before it starts rather than silently ignored.
      if (exec.signal.aborted) throw new Error('find_files was cancelled.')

      const limit = clampLimit(args.limit)
      const terms: string[] = []
      // `folder:`/`file:` alone mean "only folders"/"only files"; Everything
      // applies them to the result set, outside the name term.
      if (args.foldersOnly === true && args.filesOnly !== true) terms.push('folder:')
      if (args.filesOnly === true && args.foldersOnly !== true) terms.push('file:')
      if (scope !== undefined) terms.push(pathTerm(scope))
      terms.push(...host.exclusions())
      terms.push(toolTerm(queryText))

      const rows = await host.query({ query: terms.join(' '), max: limit })
      if (!rows.ok) throw failureToError(rows)

      const entries = toEntries(rows.results, scope).slice(0, limit)
      const result: FindFilesResult = {
        results: entries,
        count: entries.length,
        truncated: rows.total > entries.length,
        ...(scope === undefined ? {} : { scope }),
      }
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `find_files: ${args.query ?? args.path ?? ''}`,
      kind: 'search',
      rawInput: args,
    }),
    // Narrow the projected page back into the Web search card. Malformed or
    // absent metadata (an older log, a nested call) returns undefined so the card
    // falls back to the rendered text instead of throwing during replay; a
    // zero-match page is a legitimate empty card.
    presentResult: (_args, result) => {
      const meta = result?.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
      const { paths, truncated, total } = meta as { paths?: unknown; truncated?: unknown; total?: unknown }
      if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === 'string')) return undefined
      if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
      return {
        card: 'search',
        shape: 'paths',
        title: `find_files: ${String(paths.length)} path(s)`,
        paths,
        truncated,
        total,
      }
    },
  })
}

/**
 * Turn a typed backend failure into the error the model should read.
 *
 * The message names the cause and the alternative, because a model that only
 * learns "it failed" retries the same call; one that learns *why* switches to
 * `glob`.
 *
 * @param failure - the failure reported by the host.
 * @returns an error carrying an actionable message.
 */
export function failureToError(failure: SdkFailure): Error {
  if (failure.errorCode === 'IPC') {
    return new Error(
      'find_files cannot run: Everything is not running, so its index cannot be queried. '
      + 'Ask the user to start Everything, and use the built-in glob tool meanwhile.',
    )
  }
  return new Error(
    `find_files failed (${failure.errorCode}): ${failureMessage(failure)}. `
    + 'If this persists, use the built-in glob tool to search by path instead.',
  )
}
