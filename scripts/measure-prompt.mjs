/**
 * Measure the fixed context this plugin adds to every model request.
 *
 * Two different budgets are involved and they must not be added carelessly:
 * the prompt section is system-prompt text that carries no schema, while the two
 * tool definitions are schema + description carried by the tool list. Both are
 * paid on every request, so this prints them separately and then the total.
 *
 * Usage: node scripts/measure-prompt.mjs
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
const {
  EVERYTHING_SYNTAX_PROMPT,
  buildEverythingSearchTool,
} = await import('../lib/search.js')

/**
 * Estimate tokens for English prose.
 *
 * The prompts and schemas here are English and mostly ASCII, where ~4 characters
 * per token holds within a few percent. This is an estimate, not a tokenizer run.
 */
const tokens = (text) => Math.round(text.length / 4)

/** Count words the way a reader would: whitespace-separated runs. */
const words = (text) => text.trim().split(/\s+/).filter(Boolean).length

/** One line of the report. */
const row = (label, text) =>
  `| ${label} | ${String(text.length)} | ${String(words(text))} | ~${String(tokens(text))} |`

const findTool = buildFindFilesTool({ query: async () => { throw new Error('not called') }, exclusions: () => [] })
const searchTool = buildEverythingSearchTool({ query: async () => { throw new Error('not called') } })

/** The schema JSON as the model sees it: name, description, parameters. */
const schemaText = (tool) => JSON.stringify({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters ?? {},
})

const section = `${FILE_SEARCH_PROMPT}\n\n${EVERYTHING_SYNTAX_PROMPT}`
const promptChars = section.length
const schemaChars = schemaText(findTool).length + schemaText(searchTool).length
/** Token estimate from a character count, for values already measured. */
const fromChars = (count) => Math.round(count / 4)

console.log('| 项目 | 字符数 | 单词数 | 估算 token |')
console.log('|---|---:|---:|---:|')
console.log(row('FILE_SEARCH_PROMPT（find_files 段）', FILE_SEARCH_PROMPT))
console.log(row('EVERYTHING_SYNTAX_PROMPT（语法段）', EVERYTHING_SYNTAX_PROMPT))
console.log(row('系统提示词合计（两段拼接）', section))
console.log(row('find_files 工具定义', schemaText(findTool)))
console.log(row('everything_search 工具定义', schemaText(searchTool)))
console.log(`| 工具定义合计 | ${String(schemaChars)} | - | ~${String(fromChars(schemaChars))} |`)
console.log()
console.log(`系统提示词：${String(promptChars)} 字符 ≈ ${String(fromChars(promptChars))} token`)
console.log(`工具定义：  ${String(schemaChars)} 字符 ≈ ${String(fromChars(schemaChars))} token`)
console.log(`两者合计：  ${String(promptChars + schemaChars)} 字符 ≈ ${String(fromChars(promptChars + schemaChars))} token`)
