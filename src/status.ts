/**
 * The host half of the configuration card: report the state of the Everything
 * client the plugin is talking to.
 *
 * A card that only offered text fields would leave the operator guessing —
 * is the index loaded, is Everything even running, which DLL is in use? Those
 * are runtime facts about the SDK bridge, not configuration values, so they
 * cannot be derived from the settings form: they must be asked for.
 *
 * The route is registered on this bundle's own prefix. A third-party bundle owns
 * no Remote namespace of its own, so a plain `webServer` route is the mechanism
 * available; it is also enough, because the answer is one small JSON object.
 *
 * @module dsh-everything/status
 */

import type { SdkStatus } from './protocol.js'

/** Route the configuration card's requests ride. */
export const STATUS_ROUTE = '/dsh-everything/api/status'

/** The card's view of the SDK bridge. */
export interface StatusBody {
  /** Whether the Everything client answered a query. */
  available: boolean
  /** Everything client version, when the SDK could report it. */
  clientVersion?: string
  /** Whether the index is fully loaded rather than still loading. */
  databaseLoaded?: boolean
  /** Number of indexed items. */
  indexedItems?: number
  /** The DLL this plugin loaded. */
  sdkDll: string
  /** Why the client is unavailable, when it is. */
  error?: string
  /** What to do about an unavailable client. */
  hint?: string
}

/**
 * Turn one SDK status into the JSON body the card renders.
 *
 * Every field is optional except the two that always exist, so the card can tell
 * "the client answered but reports nothing" from "the client did not answer" —
 * they need different copy, and only one of them means the user has to install or
 * start something.
 *
 * @param status - the bridge's status.
 * @returns the JSON body.
 */
export function statusBody(status: SdkStatus): string {
  const body: StatusBody = {
    available: status.available,
    sdkDll: status.dllPath,
    ...(typeof status.clientVersion === 'string' ? { clientVersion: status.clientVersion } : {}),
    ...(typeof status.databaseLoaded === 'boolean' ? { databaseLoaded: status.databaseLoaded } : {}),
    ...(Number.isFinite(status.indexedItems) ? { indexedItems: status.indexedItems } : {}),
    ...(typeof status.error === 'string' ? { error: status.error } : {}),
  }
  if (!status.available) {
    body.hint = 'Everything is not answering. Start Everything.exe (the plugin only queries its index),'
      + ' or set autoStart in the plugin config.'
  }
  return JSON.stringify(body)
}
