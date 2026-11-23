/**
 * The Harness-free entry point.
 *
 * Everything reachable from here imports no `@deepseek-ai/*` package, so the
 * ranking, the query builders and the worker-reply mapping can be unit-tested on
 * a machine with no Harness installation and no Everything index.
 *
 * @module dsh-everything/pure
 */

export {
  basenameOf,
  filterExcluded,
  isWithin,
  matchesExcluded,
  rank,
  relativeToRoot,
  toWindowsPath,
} from './candidates.js'
export {
  contiguousTerm,
  escapeTerm,
  fileExclusionTerms,
  folderExclusionTerms,
  listingTerm,
  parentTerm,
  pathTerm,
  subsequenceTerm,
} from './query.js'
export { describe, failureMessage, interpret } from './protocol.js'

export type { Candidate, RawCandidate } from './candidates.js'
export type { SdkFailure, SdkMessage, SdkQuery, SdkResult, SdkRow, SdkStatus } from './protocol.js'
