/**
 * Configuration: its shape, its defaults, and the validation the Loader defers.
 *
 * Kept out of `index.ts` because none of it needs a Harness import. That is not
 * tidiness for its own sake: the validation path is the one that can leave the
 * entire bundle inactive (it did once), so it has to be testable in plain Node —
 * including the case that broke it, where every field arrives as a frozen `{ get }`
 * handle instead of a value.
 *
 * @module dsh-everything/config
 */

/**
 * Folder-name patterns filtered out of returned rows, when none is configured.
 *
 * Empty on purpose. What should be hidden is a property of the project, not of
 * the plugin: a Unity tree wants `Library` and `Output`, a Rust one `target`, a
 * monorepo neither, and a shipped default would silently hide real sources on the
 * first two and do nothing useful on the third. The card on the Plugins page is
 * where this is decided; leaving it empty means completion shows what the index
 * contains.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: string[] = []

/** Plugin configuration, validated by the Loader at load time. */
export interface Config {
  /** Maximum ranked candidates returned for one `@` query. */
  maxResults: number
  /** Rows requested from Everything before ranking. */
  maxCandidates: number
  /**
   * How long one SDK request may take before the worker is terminated, in
   * milliseconds.
   *
   * The SDK's own wait has no timeout, so this is the only bound on a hung
   * Everything IPC call. A timeout terminates the worker and the next query starts
   * a fresh one, so a single stuck call does not poison later keystrokes.
   */
  queryTimeoutMs: number
  /**
   * Folder-name patterns filtered out of returned rows.
   *
   * A name or a pattern: `Library`, `Lib*`, `Temp?`. The `*` and `?` are honoured
   * by `matchesExcluded`; the user never writes Everything syntax.
   */
  excludedDirectories: string[]
  /**
   * Folder-name patterns pruned inside the Everything query itself.
   *
   * A name or a pattern (`Library`, `Lib*`), never Everything syntax — no leading
   * `!`, no separators. `folderExclusionTerms` builds the term.
   *
   * Empty by default, and deliberately not just `excludedDirectories`: pruning
   * here happens before the candidate budget is spent (a 300-row page of a
   * Unity project lost 23% of its rows to post-hoc exclusion, and the budget is
   * what decides whether a real match is even seen), but each term measurably
   * slows the query. Put the two or three fattest generated trees here and leave
   * the rest to `excludedDirectories`.
   */
  excludeInQuery: string[]
  /**
   * File-name patterns pruned inside the Everything query.
   *
   * The same shape as {@link excludeInQuery} — a plain name or pattern, no `!` —
   * but Everything parses a file exclusion differently from a folder one, so the
   * two lists stay separate rather than making the user guess which they meant.
   * `*.meta` is a file pattern; `Library` here would mean "a *file* named
   * Library", which is why the card labels the fields instead of merging them.
   *
   * Empty by default: which generated files are noise depends on the toolchain
   * (`*.meta` for Unity, `*.pyc` for Python, `*.g.dart` for Dart).
   */
  excludeFilePatterns: string[]
  /**
   * Allow a fuzzy subsequence search when a query has no contiguous match.
   *
   * Everything answers the wildcard subsequence form from its index, so this is on
   * by default; it stays a switch because a deployment that prefers never widening
   * a query can turn it off.
   */
  fuzzyFallback: boolean
  /**
   * Launch Everything when a query fails because the client is not running.
   *
   * Off by default: starting a program is a visible side effect, and a user who
   * keeps Everything from auto-starting usually has a reason.
   */
  autoStart: boolean
  /**
   * Everything executable to launch when `autoStart` is on.
   *
   * Only used for that launch; queries themselves go through the SDK, which talks
   * to a running client and cannot start one.
   */
  everythingPath: string
  /**
   * The Everything SDK DLL to load.
   *
   * Empty means the copy bundled at `native/Everything64.dll`. A non-empty path
   * lets a deployment point at its own SDK build.
   */
  sdkPath: string
  /**
   * Install the model-facing `@path` guidance section.
   *
   * The section is the seam's stable `FILE_REFERENCE_PROMPT`; it is installed
   * only when the addressed agent can actually call `read`, matching the
   * shipped provider, so a session without filesystem tools is not told about
   * paths it cannot open.
   *
   * It governs that section only. The `find_files` guidance has no switch — a
   * user must not have to know the tool exists for the model to be told about it.
   */
  installPrompt: boolean
}

/**
 * The defaults, in one place.
 *
 * `normalizeConfig` needs them for a caller that passed a partial object, and the
 * schema needs the same numbers; keeping one table stops the two from drifting.
 */
export const DEFAULT_CONFIG = {
  maxResults: 20,
  maxCandidates: 300,
  queryTimeoutMs: 10000,
  excludedDirectories: DEFAULT_EXCLUDED_DIRECTORIES,
  excludeInQuery: [],
  excludeFilePatterns: [],
  fuzzyFallback: true,
  autoStart: false,
  everythingPath: 'C:\\Program Files\\Everything\\Everything.exe',
  sdkPath: '',
  installPrompt: true,
} as const satisfies Config

/**
 * Read the current value of a configuration field that may be a live handle.
 *
 * Every field of this plugin's Config is `volatile`, and the Loader gives such a
 * field to `apply` as `Object.freeze({ get })` rather than as the value. Anything
 * that inspects a field — validation included — has to go through `.get()`, or it
 * sees an object where it expected a number and rejects a perfectly good
 * configuration. That mistake keeps a bundle from activating at all, while every
 * unit test that passes plain objects still passes, so the unwrapping lives in
 * one exported place and every reader uses it.
 *
 * @param value - a field value, possibly a volatile handle.
 * @returns the value currently in effect.
 */
export function currentValue<T>(value: T): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function'
  ) {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

/**
 * Render a rejected configuration value for an error message.
 *
 * A rejected number is most usefully reported by type when it is an object,
 * because the common mistake is a volatile handle arriving where a value was
 * expected.
 *
 * @param value - the value that failed validation.
 * @returns a short, unambiguous rendering.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : String(value)
}

/** Characters refused in a name pattern: separators and Everything operators. */
const INVALID_PATTERN = /[\\/"<>|&^]/

/**
 * Validate configuration the Loader may have handed through unvalidated.
 *
 * Two rules, both learned the hard way:
 *
 * 1. **Validation reads through handles** via {@link currentValue}, because every
 *    field is volatile.
 * 2. **The result keeps the handles.** Returning unwrapped copies here would pin
 *    the first value forever and quietly break the whole point of `volatile` —
 *    a card edit would stop reaching the provider and the tool.
 *
 * @param config - raw configuration, with volatile fields as live handles.
 * @returns the same configuration with any omitted field defaulted.
 */
export function normalizeConfig(config: Config): Config {
  /** One field's current value, with the schema's default applied. */
  const read = <K extends keyof Config>(key: K): Config[K] => {
    const value = currentValue((config as unknown as Record<string, unknown>)[key])
    if (value !== undefined) return value as Config[K]
    return DEFAULT_CONFIG[key]
  }

  const positive = (key: 'maxResults' | 'maxCandidates' | 'queryTimeoutMs'): number => {
    const value = read(key)
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-everything: ${key} must be a positive safe integer (got ${describeValue(value)})`)
    }
    return value
  }
  positive('maxResults')
  positive('maxCandidates')
  positive('queryTimeoutMs')

  const patternList = (
    key: 'excludedDirectories' | 'excludeInQuery' | 'excludeFilePatterns',
    what: string,
  ): string[] => {
    const value = read(key)
    if (value.some((entry) => entry === '' || INVALID_PATTERN.test(entry))) {
      throw new Error(
        `dsh-everything: ${key} entries must be ${what} patterns (\\ / " < > | & ^ are refused; * and ? are allowed)`,
      )
    }
    return value
  }
  patternList('excludedDirectories', 'folder-name')
  patternList('excludeInQuery', 'folder-name')
  patternList('excludeFilePatterns', 'file-name')

  if (read('everythingPath').trim() === '') {
    throw new Error('dsh-everything: everythingPath must not be empty')
  }

  // Hand back the caller's own object, filling in only what it omitted. The
  // handles survive, so a later `live()` read still sees card edits.
  const normalized: Record<string, unknown> = { ...(config as unknown as Record<string, unknown>) }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (normalized[key] !== undefined) continue
    const fallback = DEFAULT_CONFIG[key as keyof Config]
    // Copy the array defaults: handing out the module-level array would let one
    // consumer's `push` change the default for every later load.
    normalized[key] = Array.isArray(fallback) ? [...fallback] : fallback
  }
  return normalized as unknown as Config
}
