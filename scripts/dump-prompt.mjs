/**
 * Dump the exact text this plugin contributes to a model request.
 *
 * `measure-prompt.mjs` reports sizes; this prints the strings themselves, so a
 * prompt edit can be reviewed (or handed to someone to compress) without reading
 * the source template literals by hand.
 *
 * Usage: node scripts/dump-prompt.mjs
 */

import { register } from 'node:module'

const STUB = `
export function defineTool(options) {
  return { name: options.name, description: options.description, parameters: options.parameters }
}
`
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === '@deepseek-ai/dsh-tools') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true }
  }
  return next(spec, ctx)
}`))

const { FILE_SEARCH_PROMPT, buildFindFilesTool } = await import('../lib/tool.js')
const { EVERYTHING_SYNTAX_PROMPT, buildEverythingSearchTool } = await import('../lib/search.js')

const findTool = buildFindFilesTool({ query: async () => { throw new Error('not called') }, exclusions: () => [] })
const searchTool = buildEverythingSearchTool({ query: async () => { throw new Error('not called') } })

console.log('===== FILE_SEARCH_PROMPT =====')
console.log(FILE_SEARCH_PROMPT)
console.log()
console.log('===== EVERYTHING_SYNTAX_PROMPT =====')
console.log(EVERYTHING_SYNTAX_PROMPT)
console.log()
console.log('===== SYSTEM PROMPT SECTION (FILE_SEARCH_PROMPT + blank line + EVERYTHING_SYNTAX_PROMPT) =====')
console.log(`${FILE_SEARCH_PROMPT}\n\n${EVERYTHING_SYNTAX_PROMPT}`)
console.log()
console.log('===== TOOL: everything_search =====')
console.log(`name: ${searchTool.name}`)
console.log(`description: ${searchTool.description}`)
console.log('parameters:')
for (const [name, spec] of Object.entries(searchTool.parameters ?? {})) {
  console.log(`  ${name}: ${spec.description ?? ''}`)
}
console.log()
console.log('===== TOOL: find_files =====')
console.log(`name: ${findTool.name}`)
console.log(`description: ${findTool.description}`)
console.log('parameters:')
for (const [name, spec] of Object.entries(findTool.parameters ?? {})) {
  console.log(`  ${name}: ${spec.description ?? ''}`)
}
