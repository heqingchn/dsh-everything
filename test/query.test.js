/**
 * Tests for the Everything query syntax this plugin emits.
 *
 * These pin the spellings that everything else depends on: a term that contains a
 * space would split into two AND-ed terms, and a folder exclusion that lacks the
 * trailing `\*` would hide the folder row while leaving its contents in the page.
 * Both failures are silent in a real index — they produce a plausible-looking
 * short list — so they are asserted here as exact strings.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  contiguousTerm,
  escapeTerm,
  fileExclusionTerms,
  folderExclusionTerms,
  listingTerm,
  parentTerm,
  pathTerm,
  subsequenceTerm,
} from '../lib/pure.js'

describe('escapeTerm', () => {
  it('replaces a space with a one-character wildcard', () => {
    // A quoted phrase means something else to Everything; `?` is the exact
    // substitute for a fixed-length fragment.
    assert.equal(escapeTerm('with space'), 'with?space')
  })

  it('escapes everything operators and the escape character itself', () => {
    assert.equal(escapeTerm('a&b'), 'a^&b')
    assert.equal(escapeTerm('a|b'), 'a^|b')
    assert.equal(escapeTerm('a<b'), 'a^<b')
    assert.equal(escapeTerm('a>b'), 'a^>b')
    assert.equal(escapeTerm('a^b'), 'a^^b')
    assert.equal(escapeTerm('a"b'), 'a^"b')
  })
})

describe('contiguousTerm', () => {
  it('wraps a fragment as a case-insensitive name substring', () => {
    assert.equal(contiguousTerm('Playable'), '*Playable*')
  })

  it('never emits a space, which would split into two AND-ed terms', () => {
    assert.equal(contiguousTerm('package json'), '*package?json*')
  })
})

describe('folderExclusionTerms', () => {
  it('prunes the folder and its contents, at any depth', () => {
    // `!path:Library` would also kill Library.txt and LibraryBeta; `!folder:`
    // would keep the contents. Only this form prunes the whole subtree.
    assert.deepEqual(folderExclusionTerms(['Library']), ['!path:*\\Library\\*'])
    assert.deepEqual(folderExclusionTerms(['Lib*']), ['!path:*\\Lib*\\*'])
  })

  it('emits one term per pattern and nothing for an empty list', () => {
    assert.equal(folderExclusionTerms([]).length, 0)
    assert.equal(folderExclusionTerms(['a', 'b']).length, 2)
  })
})

describe('fileExclusionTerms', () => {
  it('excludes by name with a bare leading bang', () => {
    assert.deepEqual(fileExclusionTerms(['*.meta']), ['!*.meta'])
    assert.deepEqual(fileExclusionTerms(['Thumbs.db']), ['!Thumbs.db'])
  })
})

describe('listingTerm', () => {
  it('asks for every name when the fragment is empty', () => {
    assert.equal(listingTerm(''), '**')
  })

  it('asks the index for a non-empty fragment', () => {
    // Filtering the returned page instead would lose every entry whose name sorts
    // past the page size.
    assert.equal(listingTerm('Prefab'), '*Prefab*')
  })
})

describe('subsequenceTerm', () => {
  it('joins characters with wildcards so gaps are allowed', () => {
    assert.equal(subsequenceTerm('fb'), '*f*b*')
  })

  it('matches everything for an empty query', () => {
    assert.equal(subsequenceTerm(''), '*')
  })

  it('escapes each character independently', () => {
    assert.equal(subsequenceTerm('a&b'), '*a*^&*b*')
  })
})

describe('parentTerm', () => {
  it('quotes the folder so a space stays part of one term', () => {
    assert.equal(parentTerm('C:\\a b'), 'parent:"C:\\a b"')
  })

  it('doubles a literal caret so it is not read as an escape', () => {
    assert.equal(parentTerm('C:\\a^b'), 'parent:"C:\\a^^b"')
  })
})

describe('pathTerm', () => {
  it('scopes a query to a folder subtree', () => {
    assert.equal(pathTerm('C:\\work'), 'path:"C:\\work"')
  })

  it('doubles a literal caret inside the quoted path', () => {
    assert.equal(pathTerm('C:\\a^b'), 'path:"C:\\a^^b"')
  })
})
