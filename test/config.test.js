/**
 * Tests for configuration handling with `volatile` fields.
 *
 * Every field of this plugin's Config is `volatile`, and the Loader therefore
 * hands `apply` a frozen `{ get }` handle per field rather than a value. A build
 * that read those fields directly validated a handle as if it were a number,
 * rejected a perfectly good configuration, and left the whole bundle inactive —
 * which is invisible to any test that passes plain objects. These tests pass the
 * real handle shape for exactly that reason.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { currentValue, DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js'

/**
 * Build a handle shaped like the Loader's `createVolatile`.
 * @param value - the current value.
 * @returns a frozen object whose `get()` returns it.
 */
function handle(value) {
  return Object.freeze({ get: () => value })
}

/** A configuration with every field wrapped in a volatile handle. */
function volatileConfig(overrides = {}) {
  return {
    maxResults: handle(20),
    maxCandidates: handle(300),
    queryTimeoutMs: handle(10000),
    excludedDirectories: handle([]),
    excludeInQuery: handle([]),
    excludeFilePatterns: handle([]),
    fuzzyFallback: handle(true),
    autoStart: handle(false),
    everythingPath: handle('C:\\Program Files\\Everything\\Everything.exe'),
    sdkPath: handle(''),
    installPrompt: handle(true),
    ...overrides,
  }
}

describe('currentValue', () => {
  it('unwraps a volatile handle', () => {
    assert.equal(currentValue(handle(20)), 20)
    assert.deepEqual(currentValue(handle(['a'])), ['a'])
  })

  it('exists because a handle is an object, not the value it carries', () => {
    // The regression this guards: validation saw `{ get }`, decided the number
    // was invalid, and the bundle failed to activate.
    assert.equal(typeof handle(20), 'object')
    assert.equal(currentValue(handle(20)), 20)
  })

  it('passes a plain value through untouched', () => {
    assert.equal(currentValue(20), 20)
    assert.deepEqual(currentValue(['x']), ['x'])
    assert.equal(currentValue(undefined), undefined)
  })
})

describe('normalizeConfig', () => {
  it('keeps the handles so a later card edit still reaches the plugin', () => {
    // Returning unwrapped copies would pin the first value forever and silently
    // break the whole point of `volatile`.
    const normalized = normalizeConfig(volatileConfig())
    assert.equal(typeof normalized.maxResults, 'object')
    assert.equal(currentValue(normalized.maxResults), 20)
  })

  it('fills an omitted field from the shared defaults', () => {
    const normalized = normalizeConfig({ maxResults: handle(5) })
    assert.equal(currentValue(normalized.maxResults), 5)
    assert.equal(currentValue(normalized.queryTimeoutMs), DEFAULT_CONFIG.queryTimeoutMs)
    assert.equal(currentValue(normalized.autoStart), false)
    assert.equal(currentValue(normalized.sdkPath), '')
  })

  it('hands out a fresh copy of an array default', () => {
    // A shared module-level array would let one consumer's push change the
    // default for every later load.
    const first = normalizeConfig({})
    const second = normalizeConfig({})
    first.excludedDirectories.push('Library')
    assert.deepEqual(second.excludedDirectories, [])
  })

  it('validates the handle value, not the handle', () => {
    assert.doesNotThrow(() => normalizeConfig(volatileConfig({ maxResults: handle(1) })))
  })

  it('rejects a non-positive or non-integer page size', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => normalizeConfig(volatileConfig({ maxResults: handle(value) })),
        /maxResults must be a positive safe integer/,
        `accepted ${String(value)}`,
      )
    }
  })

  it('rejects a non-positive query timeout', () => {
    assert.throws(
      () => normalizeConfig(volatileConfig({ queryTimeoutMs: handle(0) })),
      /queryTimeoutMs must be a positive safe integer/,
    )
  })

  it('rejects a folder pattern carrying a separator or an operator', () => {
    for (const pattern of ['a\\b', 'a/b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', '']) {
      assert.throws(
        () => normalizeConfig(volatileConfig({ excludeInQuery: handle([pattern]) })),
        /excludeInQuery entries must be folder-name patterns/,
        `accepted ${JSON.stringify(pattern)}`,
      )
    }
  })

  it('accepts * and ? in both pattern lists', () => {
    assert.doesNotThrow(() => normalizeConfig(volatileConfig({
      excludeInQuery: handle(['Lib*', 'Temp?']),
      excludeFilePatterns: handle(['*.meta']),
      excludedDirectories: handle(['obj*']),
    })))
  })

  it('rejects an empty Everything executable path', () => {
    assert.throws(
      () => normalizeConfig(volatileConfig({ everythingPath: handle('  ') })),
      /everythingPath must not be empty/,
    )
  })
})
