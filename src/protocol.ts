/**
 * The wire between the SDK worker and the host, plus the pure mapping from a
 * worker reply to the result or failure this plugin exposes.
 *
 * Everything here is plain data and pure functions with no Harness and no
 * `worker_threads` import, so the failure mapping — including the two causes a
 * user can fix (a stopped Everything, a missing DLL) and the one this plugin owns
 * (a timed-out request) — is testable in plain Node.
 *
 * @module dsh-everything/protocol
 */

/** One result row, already decoded to UTF-8 by the worker. */
export interface SdkRow {
  /** Absolute path, in host form. */
  path: string
  /** Final path segment. */
  name: string
  /** Whether Everything reported the entry as a directory. */
  folder: boolean
  /** File size in bytes; absent for folders. */
  size?: number
  /** ISO 8601 modification time; absent when Everything did not report one. */
  modified?: string
}

/** A successful query. */
export interface SdkResult {
  ok: true
  /** Total number of matches the index holds for this query, not just the page. */
  total: number
  /** Rows in this page. */
  returned: number
  /** The page itself. */
  results: SdkRow[]
  /** Everything client version, when the SDK could report it. */
  clientVersion?: string
  /** Whether the index is fully loaded rather than still loading. */
  databaseLoaded: boolean
}

/** A query that could not be answered. */
export interface SdkFailure {
  ok: false
  /**
   * Stable machine-readable cause.
   *
   * `IPC` is the one cause a user fixes by starting Everything, so it is kept
   * apart from every other SDK error and from this module's own failures.
   */
  errorCode: 'IPC' | 'SDK_LOAD_FAILED' | 'TIMEOUT' | 'SDK' | 'WORKER'
  /** Human-readable detail. */
  error?: string
  /** Raw `Everything_GetLastError()` code, when the SDK supplied one. */
  lastError?: number
}

/** One query request. */
export interface SdkQuery {
  /** Everything query expression, already built by the caller. */
  query: string
  /** Maximum rows to return. */
  max: number
  /** Row offset, for paging. */
  offset?: number
  /** Everything sort constant; 1 is name-ascending. */
  sort?: number
  /** Whether matching is case-sensitive. */
  matchCase?: boolean
  /**
   * Whether a bare term must match the full path rather than only the name.
   *
   * Off by default: name matching is the fast path, and the query builder keeps
   * terms name-scoped on purpose.
   */
  matchPath?: boolean
}

/** Health of the bridge and the Everything client behind it. */
export interface SdkStatus {
  /** Whether a query could be answered. */
  available: boolean
  /** Everything client version, when known. */
  clientVersion?: string
  /** Whether the index is fully loaded. */
  databaseLoaded?: boolean
  /** Number of indexed items, when the client answered. */
  indexedItems?: number
  /** How long the liveness probe took. */
  elapsedMs?: number
  /** The DLL this bridge loaded. */
  dllPath: string
  /** Why the client is unavailable, when it is. */
  error?: string
}

/** The worker's raw reply envelope. */
export interface SdkMessage {
  /** Echo of the request id. */
  id: number
  /** Whether the request succeeded. */
  ok?: boolean
  total?: number
  returned?: number
  results?: SdkRow[]
  clientVersion?: string
  databaseLoaded?: boolean
  indexedItems?: number
  elapsedMs?: number
  dllPath?: string
  errorCode?: string
  error?: string
  lastError?: number
}

/** The SDK's own error codes, as `Everything_GetLastError()` reports them. */
const SDK_ERRORS: Record<number, string> = {
  1: 'out of memory',
  2: 'Everything is not running or its IPC endpoint is unavailable',
  3: 'unable to register the SDK window class',
  4: 'unable to create the SDK listener window',
  5: 'unable to create the SDK listener thread',
  6: 'invalid result index',
  7: 'invalid call',
  8: 'invalid request data',
  9: 'invalid parameter',
}

/**
 * Turn one worker reply into the typed result or failure this plugin exposes.
 *
 * An unknown `errorCode` from a future SDK fails closed as `SDK` rather than
 * leaking an arbitrary string into the union every caller switches on.
 *
 * @param reply - the worker's reply.
 * @returns the page, or a typed failure.
 */
export function interpret(reply: SdkMessage): SdkResult | SdkFailure {
  if (reply.ok !== true) {
    const code = reply.errorCode
    const errorCode: SdkFailure['errorCode'] =
      code === 'IPC' || code === 'SDK_LOAD_FAILED' || code === 'TIMEOUT' || code === 'SDK' || code === 'WORKER'
        ? code
        : 'SDK'
    return {
      ok: false,
      errorCode,
      ...(typeof reply.error === 'string' ? { error: reply.error } : {}),
      ...(Number.isFinite(reply.lastError) ? { lastError: reply.lastError } : {}),
    }
  }
  const results = Array.isArray(reply.results) ? reply.results : []
  return {
    ok: true,
    total: Number.isFinite(reply.total) ? (reply.total as number) : results.length,
    returned: Number.isFinite(reply.returned) ? (reply.returned as number) : results.length,
    results,
    ...(typeof reply.clientVersion === 'string' ? { clientVersion: reply.clientVersion } : {}),
    databaseLoaded: reply.databaseLoaded === true,
  }
}

/**
 * The sentence a user (or the model) should read for one failure.
 *
 * Three causes get their own action because they need different fixes: starting
 * Everything, installing/repairing the SDK DLL, and retrying after a timeout.
 * Everything else is a genuine SDK error whose text is the best available detail.
 *
 * @param failure - the typed failure.
 * @returns an actionable message.
 */
export function failureMessage(failure: SdkFailure): string {
  if (failure.errorCode === 'IPC') {
    return 'Everything is not running (Everything 客户端未运行), so its index cannot be queried. '
      + 'Start Everything.exe, or enable autoStart in the dsh-everything plugin config.'
  }
  if (failure.errorCode === 'SDK_LOAD_FAILED') {
    return `Everything SDK DLL could not be loaded: ${failure.error ?? 'unknown error'}. `
      + 'Verify native/Everything64.dll exists and this Harness runs on Windows x64.'
  }
  if (failure.errorCode === 'TIMEOUT') {
    return `Everything did not answer within the query deadline: ${failure.error ?? 'timed out'}. `
      + 'Retry, or raise queryTimeoutMs in the plugin config.'
  }
  return `Everything SDK error${failure.lastError === undefined ? '' : ` ${failure.lastError}`}: `
    + `${failure.error ?? SDK_ERRORS[failure.lastError ?? -1] ?? 'unknown error'}`
}

/**
 * Render an unknown thrown value for a log line.
 *
 * @param error - thrown value.
 * @returns a non-empty description.
 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render a byte count in the units a reader can compare at a glance.
 *
 * Lives here rather than beside either tool because both the model-facing text
 * and the browser card format sizes, and the browser bundle must not pull in a
 * module that imports the tool seam.
 *
 * @param bytes - size in bytes.
 * @returns a compact size, or an empty string for an unusable value.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`
}
