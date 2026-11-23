/**
 * Guard the one class of styling bug a render test cannot see.
 *
 * A card that names a theme alias which does not exist does not fail loudly: the
 * `var()` fallback paints a colour and the page renders. The bug only appears when
 * the two halves disagree about the theme — this card's textarea used the `bg-l1`
 * alias (which does not exist, so its fallback painted white) together with
 * `label-primary` (which does, and is near-white in the dark theme). Typed text was
 * invisible.
 *
 * The suite expands components with a React stub, so no CSS is ever applied and no
 * assertion over the rendered tree could catch it. This test instead checks every
 * `--dsw-alias-*` / `--dsw-radius-*` the browser half names against the theme the
 * installed Harness actually ships.
 *
 * It self-skips when the Harness sources are not beside this checkout: the theme is
 * not part of this package, and a published install has no copy of it.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CHECKOUT = process.env.DSH_CHECKOUT ?? path.join(path.dirname(ROOT), 'deepseek-harness')
const STYLES = path.join(CHECKOUT, 'packages', 'client', 'ui-theme', 'src', 'styles')

/**
 * Read the stylesheets that define the aliases, or `undefined` when this machine
 * has no Harness checkout beside the plugin.
 */
async function readTheme() {
  try {
    const files = ['design-platform.css', 'base.css']
    const contents = await Promise.all(files.map((file) => readFile(path.join(STYLES, file), 'utf8')))
    return contents.join('\n')
  } catch {
    return undefined
  }
}

const theme = await readTheme()
const skip = theme === undefined ? `ui-theme sources not found under ${STYLES}` : false

describe('card theme tokens', { skip }, () => {
  it('names only aliases the shipped theme defines', async () => {
    const source = await readFile(path.join(ROOT, 'src', 'client.ts'), 'utf8')
    const tokens = new Set(source.match(/--dsw-(?:alias|radius)-[a-z0-9-]+/g) ?? [])
    const missing = []
    for (const token of tokens) {
      // A bare prefix, from a comment or a concatenation, is not a token.
      if (token.endsWith('-')) continue
      if (!theme.includes(`${token}:`)) missing.push(token)
    }
    assert.deepEqual(missing, [], `undefined theme aliases: ${missing.join(', ')}`)
  })

  it('does not pair a background alias with a text alias from the other theme', async () => {
    // The exact shape of the bug: a light fallback background next to a
    // theme-following text colour. Both named aliases must exist, and the text one
    // must be `label-*` (which the theme flips per mode), never a literal colour.
    const source = await readFile(path.join(ROOT, 'src', 'client.ts'), 'utf8')
    const inputs = [...source.matchAll(/background: 'var\((--dsw-alias-[a-z0-9-]+), ([^)]+)\)'/g)]
    assert.ok(inputs.length > 0, 'no themed backgrounds found; the check would be vacuous')
    for (const [statement, background, fallback] of inputs) {
      assert.ok(theme.includes(`${background}:`), `${background} is not defined by the theme`)
      assert.ok(fallback.trim() !== '', `no fallback on ${statement}`)
    }
  })
})
