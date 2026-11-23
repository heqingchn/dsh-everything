/**
 * Tests for the worker-reply mapping.
 *
 * The mapping is where a raw SDK answer becomes either a page or one of four
 * failures, and the failure code decides what the user is told: "start Everything"
 * and "reinstall the plugin" are not interchangeable advice. These tests craft
 * replies rather than running the DLL, so they cover the error paths a healthy
 * machine never produces.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { failureMessage, interpret } from '../lib/pure.js'

describe('interpret', () => {
  it('maps a successful reply, keeping the reported totals', () => {
    const result = interpret({
      id: 1,
      ok: true,
      total: 42,
      returned: 2,
      databaseLoaded: true,
      clientVersion: '1.4.1.1028',
      results: [
        { path: 'C:\\work\\a.ts', name: 'a.ts', folder: false, size: 12 },
        { path: 'C:\\work\\src', name: 'src', folder: true },
      ],
    })
    assert.equal(result.ok, true)
    assert.equal(result.total, 42)
    assert.equal(result.returned, 2)
    assert.equal(result.databaseLoaded, true)
    assert.equal(result.clientVersion, '1.4.1.1028')
    assert.equal(result.results.length, 2)
  })

  it('falls back to the page length when totals are missing', () => {
    const result = interpret({ id: 1, ok: true, results: [{ path: 'a', name: 'a', folder: false }] })
    assert.equal(result.total, 1)
    assert.equal(result.returned, 1)
    assert.equal(result.databaseLoaded, false)
  })

  it('treats a reply with no results array as an empty page, not a crash', () => {
    const result = interpret({ id: 1, ok: true })
    assert.deepEqual(result.results, [])
  })

  it('separates the missing-client cause from every other SDK error', () => {
    const ipc = interpret({ id: 1, ok: false, errorCode: 'IPC', error: 'no ipc window', lastError: 2 })
    assert.equal(ipc.ok, false)
    assert.equal(ipc.errorCode, 'IPC')
    assert.equal(ipc.lastError, 2)

    const other = interpret({ id: 1, ok: false, errorCode: 'SDK', error: 'bad call', lastError: 7 })
    assert.equal(other.errorCode, 'SDK')
  })

  it('fails closed on an unknown error code', () => {
    const result = interpret({ id: 1, ok: false, errorCode: 'FROM_THE_FUTURE' })
    assert.equal(result.errorCode, 'SDK')
  })
})

describe('failureMessage', () => {
  it('tells the user to start Everything for an IPC failure', () => {
    const message = failureMessage({ ok: false, errorCode: 'IPC' })
    assert.match(message, /Everything is not running/)
    assert.match(message, /autoStart/)
  })

  it('tells the user the DLL could not load', () => {
    const message = failureMessage({ ok: false, errorCode: 'SDK_LOAD_FAILED', error: 'missing export' })
    assert.match(message, /Everything64\.dll/)
    assert.match(message, /missing export/)
  })

  it('tells the user to retry or raise the timeout', () => {
    const message = failureMessage({ ok: false, errorCode: 'TIMEOUT', error: '200 ms' })
    assert.match(message, /queryTimeoutMs/)
    assert.match(message, /200 ms/)
  })

  it('carries the SDK detail for any other failure', () => {
    const message = failureMessage({ ok: false, errorCode: 'SDK', error: 'invalid call', lastError: 7 })
    assert.match(message, /invalid call/)
  })
})
