/**
 * One worker-thread bridge to the Everything SDK DLL.
 *
 * The index inside the local Everything client is reached through the official
 * `Everything64.dll`, loaded with the vendored N-API FFI module (koffi) inside a
 * worker thread. Two properties of the SDK make the worker mandatory rather than
 * tidy:
 *
 * - `Everything_QueryW(true)` waits for the Everything IPC reply with no
 *   timeout of its own, so a hung or busy client would block whatever thread
 *   called it.
 * - All SDK state (search text, search path, sort, request flags) is thread-affine
 *   and persists between calls, so every request is fully specified rather than
 *   relying on whatever the previous one left behind.
 *
 * Requests are serialised through one pending map, and a timed-out request
 * terminates the worker so a stuck call cannot poison every later query.
 *
 * @module dsh-everything/sdk
 */

import { Worker } from 'node:worker_threads'

import {
  describe,
  interpret,
  type SdkMessage,
  type SdkQuery,
  type SdkResult,
  type SdkFailure,
  type SdkStatus,
} from './protocol.js'

/** Bridge construction options. */
export interface SdkBridgeOptions {
  /** Absolute path to `Everything64.dll`. */
  dllPath: string
  /** Absolute path to the vendored koffi entry. */
  koffiPath: string
  /** Absolute path to the worker script. */
  workerPath: string
  /** How long one request may take before the worker is terminated. */
  timeoutMs: number | (() => number)
}

/** One pending request. */
interface Pending {
  resolve(reply: SdkMessage): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/**
 * One bridge instance, owning at most one live worker.
 *
 * A bridge is reused across queries; only a timeout or an unexpected worker exit
 * throws it away. That is what keeps the expensive part (loading a 90 KB DLL and
 * resolving koffi) out of the per-keystroke path.
 */
export class SdkBridge {
  private readonly dllPath: string
  private readonly koffiPath: string
  private readonly workerPath: string
  private readonly timeoutMs: () => number
  private worker: Worker | null = null
  private starting: Promise<Worker> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private disposed = false

  /**
   * @param options - absolute paths and the request timeout.
   */
  constructor(options: SdkBridgeOptions) {
    this.dllPath = options.dllPath
    this.koffiPath = options.koffiPath
    this.workerPath = options.workerPath
    this.timeoutMs = typeof options.timeoutMs === 'function' ? options.timeoutMs : () => options.timeoutMs as number
  }

  /** The DLL path this bridge loads, for status and diagnostics. */
  get dll(): string {
    return this.dllPath
  }

  /** Start the worker on first use, then reuse it. */
  private async ensureWorker(): Promise<Worker> {
    if (this.disposed) throw new Error('Everything SDK bridge is disposed')
    if (this.worker !== null) return this.worker
    if (this.starting === null) {
      this.starting = (async () => {
        const worker = new Worker(this.workerPath, {
          name: 'everything-sdk',
          workerData: { dllPath: this.dllPath, koffiPath: this.koffiPath },
        })
        worker.on('message', (message: SdkMessage) => {
          this.settle(message)
        })
        worker.on('error', (error: unknown) => {
          this.failAll(error instanceof Error ? error : new Error(String(error)))
        })
        worker.on('exit', () => {
          if (this.worker === worker) this.worker = null
          this.failAll(new Error('Everything SDK worker exited unexpectedly'))
        })
        worker.unref()
        this.worker = worker
        return worker
      })()
    }
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /** Resolve the request whose id this message echoes. */
  private settle(message: SdkMessage): void {
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.pending.delete(message.id)
    entry.resolve(message)
  }

  /** Reject every in-flight request, used when the worker dies. */
  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** Terminate the worker so the next request starts from a clean SDK state. */
  private reset(error: Error): void {
    const worker = this.worker
    this.worker = null
    this.failAll(error)
    if (worker !== null) void worker.terminate().catch(() => {})
  }

  /** Send one message and await its reply, bounded by the request timeout. */
  private async request(message: Record<string, unknown>): Promise<SdkMessage> {
    const worker = await this.ensureWorker()
    const id = ++this.nextId
    const timeoutMs = this.timeoutMs()
    return await new Promise<SdkMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error: Error & { code?: string } = new Error(
          `Everything SDK request timed out after ${timeoutMs} ms`,
        )
        error.code = 'TIMEOUT'
        this.reset(error)
        reject(error)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ id, ...message })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /**
   * Run one query.
   *
   * @param query - the built Everything expression plus paging.
   * @returns the page, or a typed failure.
   */
  async query(query: SdkQuery): Promise<SdkResult | SdkFailure> {
    let reply: SdkMessage
    try {
      reply = await this.request({
        type: 'query',
        query: query.query,
        max: query.max,
        offset: query.offset ?? 0,
        sort: query.sort ?? 1,
        matchCase: query.matchCase === true,
        matchPath: query.matchPath === true,
      })
    } catch (error) {
      const timedOut = (error as { code?: string } | null)?.code === 'TIMEOUT'
      return {
        ok: false,
        errorCode: timedOut ? 'TIMEOUT' : 'WORKER',
        error: describe(error),
      }
    }
    return interpret(reply)
  }

  /**
   * Probe the client: availability, version, indexed item count.
   *
   * @returns the status, never throwing for an unavailable client.
   */
  async status(): Promise<SdkStatus> {
    let reply: SdkMessage
    try {
      reply = await this.request({ type: 'status' })
    } catch (error) {
      return {
        available: false,
        dllPath: this.dllPath,
        error: describe(error),
      }
    }
    if (reply.ok === true) {
      return {
        available: true,
        dllPath: this.dllPath,
        ...(typeof reply.clientVersion === 'string' ? { clientVersion: reply.clientVersion } : {}),
        ...(typeof reply.databaseLoaded === 'boolean' ? { databaseLoaded: reply.databaseLoaded } : {}),
        ...(Number.isFinite(reply.indexedItems) ? { indexedItems: reply.indexedItems } : {}),
        ...(Number.isFinite(reply.elapsedMs) ? { elapsedMs: reply.elapsedMs } : {}),
      }
    }
    return {
      available: false,
      dllPath: this.dllPath,
      ...(typeof reply.error === 'string' ? { error: reply.error } : {}),
    }
  }

  /** Stop the worker and reject anything in flight. */
  async dispose(): Promise<void> {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    this.failAll(new Error('Everything SDK bridge disposed'))
    if (worker !== null) {
      try {
        await worker.terminate()
      } catch {
        // The worker was already gone; dispose has nothing left to release.
      }
    }
  }
}
