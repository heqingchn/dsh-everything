/**
 * Activate the plugin exactly the way the Host does.
 *
 * The activation error a `volatile` plugin hits ("1 entry did not activate … must
 * be a positive safe integer") happens before any UI exists, so no amount of unit
 * testing over plain objects can catch it. This loads the profile's own files,
 * applies the real schema, and calls `apply` with a stubbed Harness surface.
 *
 * Usage: node scripts/verify-activation.mjs [--profile <dir>]
 */

import { existsSync } from 'node:fs'
import { createRequire, register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argProfile = process.argv.indexOf('--profile')
const PROFILE = process.env.DSH_PROFILE_ROOT
  ?? (argProfile > 0 ? process.argv[argProfile + 1] : `${process.env.USERPROFILE ?? 'C:/Users/Public'}/.dsh/profiles/web`)

/** Where this package's host half is loaded from. */
const TARGETS = [
  // The installed copy first: that is what the host actually runs.
  `${PROFILE}/node_modules/dsh-everything/lib/index.js`,
  // Otherwise the build in this checkout.
  new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
]
const target = TARGETS.find((path) => existsSync(path))
if (target === undefined) {
  console.error('no build found; run `npm run build` first')
  process.exit(1)
}

// `schemastery` is a peer: a profile whose node_modules only holds the plugin
// rows resolves it from the shared profile root one level up, and a source
// checkout resolves it from its vendored copy. Falling through all three is what
// lets this script run on both kinds of machine.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const schemaCandidates = [
  () => createRequire(`${PROFILE}/package.json`).resolve('@deepseek-ai/schemastery'),
  () => createRequire(`${path.dirname(PROFILE)}/package.json`).resolve('@deepseek-ai/schemastery'),
  () => path.join(path.dirname(ROOT), 'deepseek-harness', 'vendor', 'schemastery', 'lib', 'index.mjs'),
]
let schemaEntry
for (const candidate of schemaCandidates) {
  let resolved
  try {
    resolved = candidate()
  } catch {
    continue
  }
  if (existsSync(resolved)) {
    schemaEntry = resolved
    break
  }
}
if (schemaEntry === undefined) {
  console.error(`cannot resolve @deepseek-ai/schemastery from ${PROFILE}, its parent, or a sibling checkout`)
  process.exit(1)
}

// Only the seams that need a running Harness are stubbed.
const frstub = `
export const FILE_REFERENCE_PROMPT = 'PROMPT'
export class FileReferenceService { constructor(ctx) { this.ctx = ctx } }
export default FileReferenceService
`
const toolstub = `
export function defineTool(o) {
  return { name: o.name, description: o.description, parameters: o.parameters,
           output: o.output, execute: o.execute }
}
`
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  const map = {
    '@deepseek-ai/dsh-file-reference': ${JSON.stringify(frstub)},
    '@deepseek-ai/dsh-tools': ${JSON.stringify(toolstub)},
  }
  if (map[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(map[spec]), shortCircuit: true }
  if (spec === '@deepseek-ai/schemastery') {
    return { url: ${JSON.stringify(pathToFileURL(schemaEntry).href)}, shortCircuit: true }
  }
  return next(spec, ctx)
}`))

console.log('profile:', PROFILE)
console.log('loading:', target)
const { apply, Config } = await import(`file:///${target.replaceAll('\\', '/')}`)

// Apply the schema the way the Loader does; every field becomes a handle.
const config = Config({})
const isHandle = (value) => typeof value?.get === 'function'
console.log('maxResults is a volatile handle:', isHandle(config.maxResults))
console.log('Number.isSafeInteger(config.maxResults):', Number.isSafeInteger(config.maxResults))

const registered = []
const policies = []
const routes = []
let failure
try {
  apply(
    {
      agents: { list: () => [] },
      workingDirectory: { ensure: async () => 'C:\\workspace' },
      logger: { info: (message) => console.log('  info:', message), warn: (message) => console.log('  warn:', message) },
      on: () => {},
      effect: () => {},
      fiber: { id: 'verify' },
      inject: (names, callback) => {
        // A Cordis gate is hard: the callback runs only when EVERY named service
        // is present, and runs again if one appears later. Model that here, or the
        // script would report "no tools" for a host that provides them.
        const scope = {
          effect: (factory) => {
            factory()
          },
          settings: {
            configure: (presentation, owner) => {
              policies.push({ presentation, owner })
              return () => {}
            },
          },
          tools: {
            register: (definition) => {
              registered.push(definition)
              return () => {}
            },
          },
          webServer: {
            register: (route) => {
              routes.push(route)
              return () => {}
            },
          },
        }
        if (!names.every((name) => name in scope)) return undefined
        callback(scope)
        return undefined
      },
    },
    config,
  )
} catch (error) {
  failure = error
}

if (failure !== undefined) {
  console.error('\nACTIVATION FAILED:', failure.message)
  process.exitCode = 1
} else {
  console.log('\nACTIVATION: ok')
  console.log('tools registered:', registered.map((tool) => tool.name).join(', ') || '(none)')
  console.log('status route:', routes.map((route) => route.path).join(', ') || '(none)')
  const policy = policies[0]
  console.log(
    'configuration page policy:',
    policy === undefined
      ? 'NOT CLAIMED — the Host will draw a generic form instead of the card'
      : `auto=${String(policy.presentation.auto)}`,
  )
  if (policy === undefined) process.exitCode = 1
  if (registered.length !== 1) process.exitCode = 1
  if (routes.length !== 1) process.exitCode = 1
}
