/**
 * The browser half: the configuration card on the Plugins page, and the
 * `find_files` result card in the transcript.
 *
 * ## Configuration card
 *
 * Everything's own settings are not ours to change, but which trees a
 * completion should never show is a per-project decision — a Unity workspace
 * wants `Library` and `Output` pruned, a Rust one wants `target` — and no
 * default covers both. This card is where a user says so.
 *
 * Two exclusion lists, on purpose, because they cost different things:
 *
 * - **Query-level exclusion** goes into the Everything query itself, so those
 *   rows are never counted against the candidate budget. That is the only way a
 *   match hidden behind a huge generated tree is still found, and the reason
 *   this control exists. Each entry costs query latency.
 * - **Row-level exclusion** filters what came back. Free at query time, but the
 *   budget is already spent.
 *
 * ## Result card
 *
 * `find_files` declares `output.presentationMeta`, so the card reads the
 * persisted projection instead of re-parsing model-facing text: a path
 * containing parentheses or a comma can never be misread. The collapsed row is
 * the shipped tool-row shape, and the expanded body is a plain list of paths.
 *
 * ## Why the card is written by hand
 *
 * The Harness can generate a settings page from a plugin's `Config`, but only
 * for `volatile` scalar fields. A `string[]` has no generated control, and the
 * two lists need copy explaining their trade-off — so the controls are built
 * here from `react` and the `--dsw-alias-*` theme tokens. The primitives package
 * is deliberately NOT imported: it reaches `*.module.css` and further DSH
 * packages, which would make this card unmountable in the Node test suite that
 * checks it.
 *
 * ## Why the write is read back
 *
 * `settingsScope.set()` resolving is not proof the value was stored: the profile
 * patch is written by an atomic replace, and on Windows an antivirus scanner or
 * sync client can hold it long enough that the attempt fails and the scope
 * merely reloads and returns. A save that silently did nothing would be worse
 * than no control, so every write is compared against what the scope reads back.
 *
 * @module dsh-everything/client
 */

import { Component, createElement as h, useEffect, useMemo, useState } from 'react'

import { formatBytes } from './protocol.js'

/** Stable browser-plugin name. */
export const name = 'dsh-everything'

/** Bilingual copy: one entry per locale the harness ships. */
interface Copy {
  title: string
  folderLabel: string
  folderHint: string
  folderPlaceholder: string
  fileLabel: string
  fileHint: string
  filePlaceholder: string
  rowsLabel: string
  rowsHint: string
  rowsPlaceholder: string
  save: string
  saving: string
  saved: string
  discard: string
  unavailable: string
  readOnly: string
  saveFailed: string
  invalidFolder: string
  invalidFile: string
  empty: string
  stateTitle: string
  stateAvailable: string
  stateNotRunning: string
  stateUnavailable: string
  stateChecking: string
  stateProbeFailed: string
  stateVersion: string
  stateIndexed: string
  stateIndexLoading: string
  stateDll: string
  stateRecheck: string
  stateHint: string
  resultTitle: string
  resultNoMatches: string
  resultMatchOne: string
  resultMatches: string
  resultTruncated: string
  resultShowMore: string
  resultOpen: string
  resultFolder: string
  resultFailed: string
  resultNotRunning: string
  resultFallback: string
  resultInspect: string
  resultAllDrives: string
}

/** The host's answer about the SDK bridge, as the status route serialises it. */
interface EsStatus {
  available: boolean
  clientVersion?: string
  databaseLoaded?: boolean
  indexedItems?: number
  sdkDll: string
  error?: string
  hint?: string
}

/** Where the card's status route lives. */
const STATUS_ROUTE = '/dsh-everything/api/status'

/** The settings scope snapshot this card renders from. */
interface ScopeSnapshot {
  status?: string
  writable?: boolean
  value?: Record<string, unknown>
}

/** The bound settings scope for one namespace. */
interface SettingsScope {
  getSnapshot(): ScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<unknown> | unknown
}

/** Props the settings slot hands the card. */
interface CardProps {
  t?: Copy
  settingsScope?: SettingsScope
  view?: string
}

/** One labelled textarea's props. */
interface NameListFieldProps {
  id: string
  label: string
  hint: string
  placeholder: string
  value: string
  disabled: boolean
  invalid: boolean
  /** Copy shown in place of the hint when the text is unusable. */
  invalidText: string
  onChange: (text: string) => void
}

/**
 * Services required before `apply` runs.
 *
 * A Cordis dependency gate is hard: an entry the running Harness does not
 * provide keeps `apply` from ever running. Both settings lines provide `slots`
 * and `locale`; the settings transport itself is probed with `ctx.get()`, which
 * answers `undefined` rather than throwing when it is absent, so one build
 * serves a deployment whose settings surface differs or is missing.
 */
export const inject = ['slots', 'locale']

/** Settings namespace and profile entry id. */
const NAMESPACE = 'dsh-everything'

/**
 * Every spelling the Host may have used for this bundle's settings namespace.
 *
 * `SettingsForms.describe()` keys a form by the **Loader entry id**, and the
 * profile patch picks that id — so the browser half has to ask rather than
 * assume. The entry in this bundle's own patch is `file-reference-everything`;
 * a deployment that installed the package under its bare name, or that wrapped
 * it with `include:`, spells it differently. Trying each in order is what keeps
 * the card bound on all three.
 */
const SETTINGS_NAMESPACE_CANDIDATES = ['file-reference-everything', NAMESPACE, 'include:file-reference-everything']

/** Card copy, in both languages the harness ships. */
const COPY: Record<'zh' | 'en', Copy> = {
  zh: {
    title: '排除的目录与文件',
    folderLabel: '排除文件夹',
    folderHint:
      '直接写文件夹名或通配符，例如 Library、Lib*、Temp?。不需要写 !，插件会自己拼成 Everything 的排除语法。这些文件夹连同内容一起在查询阶段被剪掉，不占候选配额——只有这样，藏在 Library/、Output/ 这类大目录后面的真实匹配才找得到。代价是每次查询多几毫秒，填最肥的两三个即可。',
    folderPlaceholder: '每行一个，例如 Library 或 Lib*',
    fileLabel: '排除文件',
    fileHint: '直接写文件名或通配符，例如 *.meta、*.pyc、*.g.dart、Thumbs.db。同样写进查询，也不占配额。',
    filePlaceholder: '每行一个，例如 *.meta',
    rowsLabel: '仅在结果里排除（不建议填）',
    rowsHint:
      '从返回结果里过滤，查询时零成本，但被丢掉的行已经消耗了 maxCandidates 配额。只在目录实在太多、不想让查询变慢时使用；优先用上面两项。',
    rowsPlaceholder: '每行一个，例如 obj 或 obj*',
    save: '保存',
    saving: '保存中…',
    saved: '已保存',
    discard: '放弃修改',
    unavailable: '该插件当前未加载，或本部署未开放它的配置。',
    readOnly: '本部署的设置为只读。',
    saveFailed: '保存未被接受，改动已保留供你重试。',
    invalidFolder: '不能为空，也不能包含 \\ / " < > | & ^（* 和 ? 可用）',
    invalidFile: '不能为空，也不能包含 \\ / " < > | & ^（* 和 ? 可用）',
    empty: '当前没有排除项：索引里有的目录和文件都会出现在补全里。',
    stateTitle: 'Everything 状态',
    stateAvailable: 'Everything 可用',
    stateNotRunning: 'Everything 未运行',
    stateUnavailable: 'Everything 不可用',
    stateChecking: '检测中…',
    stateProbeFailed: '无法读取状态（宿主路由未响应）。若插件已启用仍如此，请检查 Everything 是否在运行。',
    stateVersion: '版本',
    stateIndexed: '索引条目',
    stateIndexLoading: '索引加载中',
    stateDll: 'SDK DLL',
    stateRecheck: '重新检测',
    stateHint: '启动 Everything.exe（本插件只查询它的索引），或在 plugins.patch.yml 里打开 autoStart。',
    resultTitle: 'find_files',
    resultNoMatches: '无匹配',
    resultMatchOne: '1 项匹配',
    resultMatches: '{total} 项匹配',
    resultTruncated: '结果已截断',
    resultShowMore: '仅显示前 {shown} 项（共 {returned} 项）。提高 limit 或缩小查询范围可看到更多。',
    resultOpen: '打开 {name}',
    resultFolder: '文件夹',
    resultFailed: '查询失败',
    resultNotRunning: 'Everything 未运行',
    resultFallback: '结果原文',
    resultInspect: '检查调用',
    resultAllDrives: '全部已索引磁盘',
  },
  en: {
    title: 'Excluded folders and files',
    folderLabel: 'Exclude folders',
    folderHint:
      'Type a folder name or a wildcard: Library, Lib*, Temp?. No leading ! — the plugin builds the Everything syntax itself. These folders and their contents are pruned inside the query, so they never spend the candidate budget — the only way a real match behind a huge Library/ or Output/ is still found. Costs a few ms per query; list the two or three fattest.',
    folderPlaceholder: 'One per line, e.g. Library or Lib*',
    fileLabel: 'Exclude files',
    fileHint:
      'Type a file name or a wildcard: *.meta, *.pyc, *.g.dart, Thumbs.db. Also pruned inside the query, also free of the budget.',
    filePlaceholder: 'One per line, e.g. *.meta',
    rowsLabel: 'Exclude from results only (avoid)',
    rowsHint:
      'Filtered out of the returned rows. Free at query time, but those rows already consumed the maxCandidates budget. Use it only when there are too many folders to put in the query; prefer the two above.',
    rowsPlaceholder: 'One per line, e.g. obj or obj*',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    discard: 'Discard',
    unavailable: 'This plugin is not loaded, or this deployment exposes no configuration.',
    readOnly: 'This deployment is read-only.',
    saveFailed: 'The save was not accepted; your edits are kept so you can retry.',
    invalidFolder: 'Cannot be empty or contain \\ / " < > | & ^ (* and ? are allowed)',
    invalidFile: 'Cannot be empty or contain \\ / " < > | & ^ (* and ? are allowed)',
    empty: 'Nothing excluded: every indexed folder and file can appear in completion.',
    stateTitle: 'Everything status',
    stateAvailable: 'Everything is available',
    stateNotRunning: 'Everything is not running',
    stateUnavailable: 'Everything is unavailable',
    stateChecking: 'Checking…',
    stateProbeFailed: 'Could not read the status (the host route did not answer). If the plugin is enabled, check whether Everything is running.',
    stateVersion: 'Version',
    stateIndexed: 'Indexed items',
    stateIndexLoading: 'index loading',
    stateDll: 'SDK DLL',
    stateRecheck: 'Re-check',
    stateHint: 'Start Everything.exe (the plugin only queries its index), or enable autoStart in plugins.patch.yml.',
    resultTitle: 'find_files',
    resultNoMatches: 'No matches',
    resultMatchOne: '1 match',
    resultMatches: '{total} matches',
    resultTruncated: 'truncated',
    resultShowMore: 'Showing the first {shown} of {returned} returned rows. Raise limit or narrow the query to see more.',
    resultOpen: 'Open {name}',
    resultFolder: 'folder',
    resultFailed: 'Search failed',
    resultNotRunning: 'Everything is not running',
    resultFallback: 'Recorded result',
    resultInspect: 'Inspect call',
    resultAllDrives: 'Every indexed drive',
  },
}

/** Folder-name patterns the host refuses, mirroring `normalizeConfig`. */
const INVALID_FOLDER = /[\\/"<>|&^]/

/** File-name patterns the host refuses: wildcards are allowed, separators are not. */
const INVALID_PATTERN = /[\\/"<>|&^]/

/**
 * Split a textarea's text into directory basenames.
 *
 * Blank lines are dropped rather than treated as an empty name, so a trailing
 * newline while typing is not an error. Surrounding whitespace is trimmed for
 * the same reason: a pasted list often carries it.
 *
 * @param text - the control's raw text.
 * @returns the basenames, or `undefined` when any line is unusable.
 */
export function parseNames(text: string, invalid: RegExp = INVALID_FOLDER): string[] | undefined {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    // Tolerate a pasted Everything term: the card asks for a bare pattern, but a
    // user copying `!Library` from a query should not be told it is invalid. The
    // plugin adds its own marker, so a leading `!` would otherwise be doubled.
    const name = line.trim().replace(/^!/, '').trim()
    if (name === '') continue
    if (invalid.test(name)) return undefined
    names.push(name)
  }
  return names
}

/**
 * Parse a file-name pattern list.
 *
 * Separate from {@link parseNames} only in which characters are refused:
 * wildcards are the point of a pattern, so `*` and `?` are legal here and a path
 * separator is not.
 *
 * @param text - the control's raw text.
 * @returns the patterns, or `undefined` when any line is unusable.
 */
export function parseFilePatterns(text: string): string[] | undefined {
  return parseNames(text, INVALID_PATTERN)
}

/**
 * Render a list of basenames as the control's text.
 * @param names - the stored values.
 * @returns one name per line.
 */
export function formatNames(names: unknown): string {
  return Array.isArray(names) ? (names as unknown[]).filter((n): n is string => typeof n === 'string').join('\n') : ''
}

/** One labelled textarea plus its hint. */
function NameListField({ id, label, hint, placeholder, value, disabled, invalid, invalidText, onChange }: NameListFieldProps) {
  return h('div', { style: FIELD }, [
    h('label', { key: 'label', htmlFor: id, style: LABEL }, label),
    h('textarea', {
      key: 'input',
      id,
      value,
      placeholder,
      disabled,
      rows: 3,
      spellCheck: false,
      'aria-invalid': invalid === true,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      style: invalid === true ? { ...INPUT, borderColor: 'var(--dsw-alias-state-error-primary, #c0392b)' } : INPUT,
    }),
    h('p', { key: 'hint', style: invalid === true ? HINT_INVALID : HINT }, invalid === true ? invalidText : hint),
  ])
}

/**
 * The card's visual constants.
 *
 * Every `var()` carries a fallback, and every token name is one the shipped themes
 * actually define. That is not defensive padding: an unresolvable `var()` with no
 * fallback invalidates the whole declaration, so `border: 1px solid var(…)` drops
 * to `border: none` and the inputs look like loose text.
 *
 * Names verified against the deployment: `bg-l1`, `border-l1`, `border-l2`,
 * `label-primary`, `label-secondary`, `label-tertiary`, `state-error-primary`,
 * `settings-card-fill`, `markdown-code-block`.
 */
const FIELD = { display: 'flex', flexDirection: 'column', gap: '6px', margin: '0 0 18px' }
const LABEL = { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1f2329)' }
const INPUT = {
  font: 'inherit',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '12.5px',
  lineHeight: 1.55,
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  // `bg-base`, not the `bg-l1` this card used to name: that alias does not exist,
  // so the fallback painted a white box while `label-primary` stayed light in the
  // dark theme — typed text was invisible. `test/theme.test.js` now checks every
  // alias this half uses against the shipped theme.
  background: 'var(--dsw-alias-bg-base, #ffffff)',
  border: '1px solid var(--dsw-alias-border-l2, #d5d8dd)',
  borderRadius: '8px',
  padding: '8px 10px',
  boxSizing: 'border-box',
  width: '100%',
  resize: 'vertical',
  minHeight: '72px',
  outline: 'none',
}
const HINT = {
  margin: '0',
  fontSize: '12px',
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}
const HINT_INVALID = { ...HINT, color: 'var(--dsw-alias-state-error-primary, #c0392b)' }
const ACTIONS = { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 0' }
const BUTTON = {
  font: 'inherit',
  fontSize: '12.5px',
  padding: '6px 14px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, #d5d8dd)',
  // `bg-layer-2`, not `settings-card-fill`: that alias does not exist either, and a
  // light-grey fallback under light `label-primary` text repeated the invisible-text
  // bug on every button.
  background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  cursor: 'pointer',
}
const STATUS = { margin: '0', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' }
/** The status line, when there is a runtime fact to show. */
const STATUS_DETECTED = {
  margin: '0',
  fontSize: '12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  wordBreak: 'break-all',
}
/** Section heading, one step below the host's own page title. */
const HEADING = {
  margin: '6px 0 12px',
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  paddingBottom: '6px',
  borderBottom: '1px solid var(--dsw-alias-border-l1, #e8eaed)',
}

/** The transcript card's constants; the row copies the shipped tool-row metrics. */
const ROW = {
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  minWidth: 0,
  height: 'calc(24px + var(--dsh-content-font-delta, 0px))',
  padding: 0,
  border: 'none',
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const ROW_TITLE = {
  flex: 'none',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
  color: 'inherit',
  whiteSpace: 'nowrap',
}
const SEP = {
  flex: 'none',
  width: '2px',
  height: '2px',
  margin: '0 8px',
  borderRadius: '1px',
  background: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))',
}
const SUMMARY = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
  color: 'inherit',
}
const SUFFIX = {
  flex: '0 1 auto',
  minWidth: 0,
  marginLeft: '8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
  color: 'inherit',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}
const CARD_BODY = {
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  margin: '4px 0 4px 4px',
  padding: '8px 12px',
  border: '0.5px solid var(--dsw-alias-border-l1, #e8eaed)',
  borderRadius: 'var(--dsw-radius-lg, 10px)',
  background: 'var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2, #f7f8fa))',
  fontFamily: 'var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary, #4b5563)',
}
const BODY_LINE = {
  margin: 0,
  padding: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'inherit',
  border: 'none',
  background: 'none',
  font: 'inherit',
  textAlign: 'left',
}
const HIT_ROW = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  minWidth: 0,
  padding: 0,
  overflow: 'hidden',
  border: 'none',
  background: 'none',
  font: 'inherit',
  textAlign: 'left',
  color: 'inherit',
  whiteSpace: 'nowrap',
}
const HIT_NAME = {
  flex: 'none',
  maxWidth: '45%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  padding: 0,
  border: 'none',
  background: 'none',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
}
const HIT_PATH = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  // Dimmer than the name on purpose: a row is `name  parent-path`, and equal
  // weight makes the two read as one long string.
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}
const HIT_META = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
  fontVariantNumeric: 'tabular-nums',
}

/** Most rows the expanded card draws before folding, matching the shipped card blocks. */
const CARD_ROW_DISPLAY = 8

/** One row of the persisted projection. */
interface CardRow {
  path: string
  name: string
  folder: boolean
  /** File size in bytes; absent for folders and for `find_files` rows. */
  size?: number
  /** ISO 8601 modification time; absent for `find_files` rows. */
  modified?: string
}

/** The persisted `find_files` projection, as this card reads it. */
interface SearchModel {
  rows: CardRow[]
  total: number
  returned: number
  truncated: boolean
}

/** The props the `tool.call.toolview` slot hands a card. */
interface ToolCardProps {
  /** The settled or in-flight call block. */
  block?: {
    meta?: unknown
    content?: unknown
    isError?: boolean
    error?: { code?: string }
    args?: unknown
    call?: { argsRaw?: unknown }
  }
  /** `preparing`, `running` or `result`. */
  phase?: string
  /** Locale-bound translator, when the shell provides one. */
  t?: (key: string, params?: Record<string, unknown>) => string
  /** Call identifier, used for the body's `id`. */
  callId?: string
  /** Open a path in the sidebar, when the shell provides it. */
  openFile?: (path: string) => void
  /** Show the raw call inspector, when the shell provides it. */
  inspect?: () => void
  /** Owner disclosure hook, when the shell provides one. */
  useDisclosure?: () => { expanded?: boolean; toggle?: () => void }
}

/** Narrow unknown JSON to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** First line of arbitrary text, trimmed. */
function firstLine(text: unknown): string {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const newline = trimmed.indexOf('\n')
  return newline === -1 ? trimmed : trimmed.slice(0, newline).trim()
}

/** Flatten a settled tool result's content blocks to display text. */
function resultText(block: ToolCardProps['block']): string {
  const parts: string[] = []
  const content = Array.isArray(block?.content) ? block.content : []
  for (const part of content) {
    const record = asRecord(part)
    if (record === null) continue
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else parts.push(JSON.stringify(record, null, 2))
  }
  return parts.join('\n').trim()
}

/** Read one string argument from the call's lazy argument view, then from raw JSON. */
function argText(block: ToolCardProps['block'], key: string): string {
  const view = block?.args
  if (view !== null && typeof view === 'object' && typeof (view as { text?: unknown }).text === 'function') {
    try {
      const value = (view as { text(key: string): unknown }).text(key)
      if (typeof value === 'string') return value
    } catch {
      // A partially prepared argument view can refuse reads; fall through.
    }
  }
  const call = asRecord(block?.call)
  if (call === null || typeof call.argsRaw !== 'string') return ''
  try {
    const args = asRecord(JSON.parse(call.argsRaw))
    const value = args?.[key]
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** Localized integer formatting; falls back to the raw digits when Intl fails. */
function formatCount(value: number, localeTag: string): string {
  if (!Number.isFinite(value)) return ''
  try {
    return new Intl.NumberFormat(localeTag).format(value)
  } catch {
    return String(value)
  }
}

/**
 * Render a modification timestamp in the reader's local time.
 *
 * Everything reports FILETIME-derived ISO strings in UTC; printing one verbatim
 * would show a `dm:today` hit as yesterday's date for most of the world.
 *
 * @param raw - the ISO value from the projection.
 * @param localeTag - BCP 47 tag for formatting.
 * @returns the short local date-time, or an empty string for an unusable value.
 */
function formatModified(raw: unknown, localeTag: string): string {
  if (typeof raw !== 'string' || raw === '') return ''
  const milliseconds = Date.parse(raw)
  if (!Number.isFinite(milliseconds)) return ''
  try {
    return new Intl.DateTimeFormat(localeTag, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(milliseconds))
  } catch {
    return ''
  }
}

/** Parent directory of a full path, without the file name. */
function parentPath(fullPath: string): string {
  const slash = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'))
  return slash > 0 ? fullPath.slice(0, slash) : ''
}

/** Keep a Windows parent path readable in one line: first segment, ellipsis, last two. */
function compactParentPath(parent: string): string {
  if (parent === '') return ''
  const unc = parent.startsWith('\\\\')
  const segments = parent.split(/[\\/]+/).filter((segment) => segment !== '')
  if (unc) segments[0] = `\\\\${segments[0] ?? ''}`
  if (segments.length <= 4) return parent
  const head = segments[0]
  const tail = segments.slice(-2).join('\\')
  return `${head}\\…\\${tail}`
}

/** Best-effort locale tag for Intl formatting when no `t` seat is bound. */
function detectLocaleTag(): string {
  try {
    const language = typeof navigator === 'undefined' ? '' : navigator.language
    return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * Translate through the active copy table.
 *
 * The copy is resolved here rather than through `ctx.locale.bind()`, whose return
 * value is a lookup function rather than an object of strings: treating that as a
 * table yields `undefined` for every label while data-driven values still render.
 *
 * @param copy - one complete copy table.
 * @returns a translator closing over it.
 */
function translate(copy: Copy): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template = (copy as unknown as Record<string, string>)[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }
}

/**
 * Build the card's translator.
 *
 * The shell hands a card a locale-bound lookup, but this bundle registers no
 * locale dictionary, so that lookup answers the key itself for every string here.
 * Preferring it unconditionally therefore rendered `resultMatches` on screen. The
 * bound lookup is still consulted first — a deployment that does register a
 * dictionary should win — but a miss (a non-string, an empty result, or the key
 * echoed back) falls through to this module's own table.
 *
 * @param bound - the shell's lookup, when it passed one.
 * @param copy - one complete copy table.
 * @returns a translator that never returns a bare key for a known string.
 */
function boundTranslator(
  bound: ToolCardProps['t'],
  copy: Copy,
): (key: string, params?: Record<string, unknown>) => string {
  const local = translate(copy)
  if (typeof bound !== 'function') return local
  return (key, params) => {
    let value: unknown
    try {
      value = bound(key, params)
    } catch {
      value = undefined
    }
    return typeof value === 'string' && value !== '' && value !== key ? value : local(key, params)
  }
}

/**
 * Validate and normalize the persisted projection of either tool.
 *
 * Two shapes reach this card: `paths`, the plain path list `find_files` writes, and
 * `entries`, the rows `everything_search` writes with size and modification time.
 * Both narrow to one model so the card has a single render path.
 *
 * @param meta - `block.meta`, of unknown shape.
 * @returns the model, or `null` when the metadata is absent or foreign.
 */
export function normalizeSearchMeta(meta: unknown): SearchModel | null {
  const record = asRecord(meta)
  if (record === null || record.version !== 1) return null
  if (record.shape === 'paths') {
    if (!Array.isArray(record.paths)) return null
    const rows: CardRow[] = []
    for (const entry of record.paths) {
      if (rows.length >= 100) break
      if (typeof entry !== 'string' || entry === '') continue
      const name = entry.replace(/\\+$/, '')
      rows.push({
        path: entry,
        name: name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1),
        folder: entry.endsWith('\\'),
      })
    }
    return {
      rows,
      total: Number.isFinite(record.total) ? (record.total as number) : rows.length,
      returned: rows.length,
      truncated: record.truncated === true,
    }
  }
  if (record.shape === 'entries') {
    if (!Array.isArray(record.rows)) return null
    const rows: CardRow[] = []
    for (const entry of record.rows) {
      if (rows.length >= 100) break
      const row = asRecord(entry)
      if (row === null || typeof row.path !== 'string' || row.path === '') continue
      const name = row.path.replace(/\\+$/, '')
      rows.push({
        path: row.path,
        name: typeof row.name === 'string' && row.name !== ''
          ? row.name
          : name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1),
        folder: row.directory === true,
        ...(Number.isFinite(row.size) ? { size: row.size as number } : {}),
        ...(typeof row.modified === 'string' ? { modified: row.modified } : {}),
      })
    }
    return {
      rows,
      total: Number.isFinite(record.total) ? (record.total as number) : rows.length,
      returned: rows.length,
      truncated: record.truncated === true,
    }
  }
  return null
}

/**
 * The configuration card.
 *
 * Staged-edit semantics, matching every host settings page: edits live in local
 * state until Save, so a half-typed list is never written, and Discard restores
 * the stored values.
 *
 * @param props - `t`, the settings scope, and the view the page asks for.
 * @returns the card, or the framework's unavailable notice.
 */
export function EverythingCard(props: CardProps) {
  const { t, settingsScope, view } = props
  const copy: Copy = t ?? COPY.zh
  const snapshot = useSettingsSnapshot(settingsScope)

  const stored = useMemo(() => {
    const value = (snapshot.value ?? {}) as Record<string, unknown>
    return {
      folders: formatNames(value.excludeInQuery),
      patterns: formatNames(value.excludeFilePatterns),
      rows: formatNames(value.excludedDirectories),
    }
  }, [snapshot.value])

  const [folderText, setFolderText] = useState(stored.folders)
  const [patternText, setPatternText] = useState(stored.patterns)
  const [rowsText, setRowsText] = useState(stored.rows)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [justSaved, setJustSaved] = useState(false)
  const [status, setStatus] = useState<EsStatus | undefined>(undefined)
  const [checking, setChecking] = useState(true)
  const [probeFailed, setProbeFailed] = useState(false)

  // Adopt a value that arrives after the first paint (the scope settles
  // asynchronously), and drop it while the user has unsaved edits, so an
  // unrelated settings reload cannot overwrite what they are typing.
  const dirty = folderText !== stored.folders || patternText !== stored.patterns || rowsText !== stored.rows
  useEffect(() => {
    if (dirty) return
    setFolderText(stored.folders)
    setPatternText(stored.patterns)
    setRowsText(stored.rows)
  }, [stored.folders, stored.patterns, stored.rows, dirty])

  // Ask the host for the client's health. It cannot be derived from the form:
  // the answer is a runtime fact about the SDK bridge, and it changes when the
  // user starts Everything without touching this card.
  const recheck = useStatusFetcher(setStatus, setChecking, setProbeFailed)
  useEffect(() => {
    void recheck()
  }, [recheck])

  if (settingsScope === undefined) {
    return h('p', { style: STATUS }, copy.unavailable)
  }
  if (snapshot.status !== 'ready') {
    return h('p', { style: STATUS }, snapshot.status === 'unavailable' ? copy.unavailable : copy.saving)
  }

  const readonly = snapshot.writable !== true
  const folderNames = parseNames(folderText)
  const filePatterns = parseFilePatterns(patternText)
  const rowNames = parseNames(rowsText)
  const invalid = folderNames === undefined || filePatterns === undefined || rowNames === undefined

  const save = async () => {
    if (readonly || invalid || busy) return
    setBusy(true)
    setFailure(undefined)
    setJustSaved(false)
    try {
      // Each field is written and checked on its own: one rejected write must not
      // report the others as saved.
      await writeAndVerify(settingsScope, 'excludeInQuery', folderNames ?? [])
      await writeAndVerify(settingsScope, 'excludeFilePatterns', filePatterns ?? [])
      await writeAndVerify(settingsScope, 'excludedDirectories', rowNames ?? [])
      setJustSaved(true)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const children: unknown[] = [
    h('div', { key: 'state', style: FIELD }, [
      h('h3', { key: 'title', style: HEADING }, copy.stateTitle),
      h('p', { key: 'line', style: status?.available === true ? STATUS_DETECTED : STATUS, role: 'status' }, describeStatus(
        { status, failed: probeFailed, checking },
        copy,
      )),
      h('div', { key: 'actions', style: ACTIONS }, [
        h('button', {
          key: 'recheck',
          type: 'button',
          style: { ...BUTTON, whiteSpace: 'nowrap', cursor: checking ? 'progress' : 'pointer' },
          disabled: checking,
          onClick: () => {
            void recheck()
          },
        }, checking ? copy.stateChecking : copy.stateRecheck),
      ]),
    ]),
    h('h3', { key: 'title', style: HEADING }, copy.title),
    h(NameListField, {
      key: 'folders',
      id: 'dsh-everything-exclude-folders',
      label: copy.folderLabel,
      hint: copy.folderHint,
      placeholder: copy.folderPlaceholder,
      value: folderText,
      disabled: readonly || busy,
      invalid: folderNames === undefined,
      invalidText: copy.invalidFolder,
      onChange: setFolderText,
    }),
    h(NameListField, {
      key: 'patterns',
      id: 'dsh-everything-exclude-patterns',
      label: copy.fileLabel,
      hint: copy.fileHint,
      placeholder: copy.filePlaceholder,
      value: patternText,
      disabled: readonly || busy,
      invalid: filePatterns === undefined,
      invalidText: copy.invalidFile,
      onChange: setPatternText,
    }),
    h(NameListField, {
      key: 'rows',
      id: 'dsh-everything-exclude-rows',
      label: copy.rowsLabel,
      hint: copy.rowsHint,
      placeholder: copy.rowsPlaceholder,
      value: rowsText,
      disabled: readonly || busy,
      invalid: rowNames === undefined,
      invalidText: copy.invalidFolder,
      onChange: setRowsText,
    }),
  ]

  if (stored.folders === '' && stored.patterns === '' && stored.rows === '' && !dirty) {
    children.push(h('p', { key: 'empty', style: STATUS }, copy.empty))
  }

  children.push(
    h('div', { key: 'actions', style: ACTIONS }, [
      h('button', {
        key: 'save',
        type: 'button',
        style: { ...BUTTON, opacity: readonly || invalid || busy || !dirty ? 0.5 : 1 },
        disabled: readonly || invalid || busy || !dirty,
        onClick: save,
      }, busy ? copy.saving : copy.save),
      h('button', {
        key: 'discard',
        type: 'button',
        style: { ...BUTTON, opacity: !dirty || busy ? 0.5 : 1 },
        disabled: !dirty || busy,
        onClick: () => {
          setFolderText(stored.folders)
          setPatternText(stored.patterns)
          setRowsText(stored.rows)
          setFailure(undefined)
          setJustSaved(false)
        },
      }, copy.discard),
      justSaved ? h('p', { key: 'ok', style: STATUS, role: 'status' }, copy.saved) : null,
      failure === undefined
        ? null
        : h('p', { key: 'err', style: HINT_INVALID, role: 'status' }, `${copy.saveFailed} ${failure}`),
    ]),
  )

  if (readonly) children.unshift(h('p', { key: 'ro', style: STATUS, role: 'status' }, copy.readOnly))
  // `view` is only used by the page to ask for a one-liner; this card has none.
  void view

  return h('div', { 'data-plugin': NAMESPACE }, children)
}

/**
 * Build the status fetcher, kept stable across renders.
 *
 * `useMemo` with no dependencies gives one identity for the component's life, so
 * the effect that re-checks on mount cannot turn into a request loop.
 *
 * A transport or HTTP failure is reported as `failed`, not as "nothing found":
 * the two need different advice, and conflating them told users to start
 * Everything when the real problem was that the Host route never answered.
 *
 * @param setStatus - receives the host's answer.
 * @param setChecking - tracks the in-flight state so the button can say so.
 * @param setFailed - marks a probe that could not be read.
 * @returns a stable callback that re-asks the host.
 */
function useStatusFetcher(
  setStatus: (value: EsStatus | undefined) => void,
  setChecking: (value: boolean) => void,
  setFailed: (value: boolean) => void,
): () => Promise<void> {
  return useMemo(() => async () => {
    setChecking(true)
    setFailed(false)
    try {
      const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) {
        setStatus(undefined)
        setFailed(true)
        return
      }
      setStatus((await response.json()) as EsStatus)
    } catch {
      // The `@` provider is unaffected; only this readout is unknown.
      setStatus(undefined)
      setFailed(true)
    } finally {
      setChecking(false)
    }
  }, [setStatus, setChecking, setFailed])
}

/**
 * Subscribe to a settings scope and re-render on change.
 * @param scope - the bound settings scope, or undefined when absent.
 * @returns the current snapshot, or a neutral one.
 */
function useSettingsSnapshot(scope: SettingsScope | undefined): ScopeSnapshot {
  const [snapshot, setSnapshot] = useState<ScopeSnapshot>(() =>
    scope === undefined ? { status: 'unavailable' } : scope.getSnapshot(),
  )
  useEffect(() => {
    if (scope === undefined) return undefined
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
  }, [scope])
  return snapshot
}

/**
 * Write one field and confirm the scope read it back.
 *
 * `set()` resolving means the request was answered, not that the document was
 * replaced — see the module comment. Comparing the read-back is the only
 * reliable check, and it is what the official cards do.
 *
 * @param scope - the bound settings scope.
 * @param field - the Config field to write.
 * @param value - the complete next value for that field.
 * @throws when the value does not read back, so the card reports a real failure.
 */
export async function writeAndVerify(
  scope: SettingsScope,
  field: string,
  value: readonly string[],
): Promise<void> {
  await scope.set(field, [...value])
  const readBack = (scope.getSnapshot().value ?? {})[field]
  const same =
    Array.isArray(readBack) &&
    readBack.length === value.length &&
    readBack.every((entry, index) => entry === value[index])
  if (!same) {
    throw new Error(`${field} did not persist (read back ${JSON.stringify(readBack)})`)
  }
}

/**
 * Render the status line.
 *
 * It answers the question the form itself cannot: *is* Everything answering, how
 * old is the client, and how big is the index. Three outcomes are kept apart on
 * purpose — "the client is not running" and "the Host could not be asked" look
 * identical in an empty variable but need opposite advice.
 *
 * @param state - the probe's current state.
 * @param copy - the card's copy.
 * @returns the status line.
 */
export function describeStatus(
  state: { status?: EsStatus; failed: boolean; checking: boolean },
  copy: Copy,
): string {
  // While the first probe is in flight the button already says so; repeating it on
  // the line below would read as two separate states.
  if (state.checking && state.status === undefined) return ''
  if (state.failed && state.status === undefined) return copy.stateProbeFailed
  const status = state.status
  if (status === undefined) return copy.stateProbeFailed
  if (!status.available) {
    const detail = status.error === undefined ? '' : ` (${firstLine(status.error)})`
    return `${copy.stateNotRunning}${detail} — ${copy.stateHint}`
  }
  const parts = [copy.stateAvailable]
  if (status.clientVersion !== undefined) parts.push(`${copy.stateVersion} ${status.clientVersion}`)
  if (status.databaseLoaded === false) {
    parts.push(copy.stateIndexLoading)
  } else if (status.indexedItems !== undefined) {
    parts.push(`${copy.stateIndexed} ${formatCount(status.indexedItems, detectLocaleTag())}`)
  }
  return `${parts.join(' · ')} — ${status.sdkDll}`
}

/**
 * The `find_files` result card.
 *
 * @param props - the call block, its phase, and the shell's seats.
 * @returns the collapsed row, or the row plus the expanded body.
 */
export function FindFilesCard(props: ToolCardProps) {
  const { block, phase, callId, openFile, inspect } = props
  const tag = detectLocaleTag()
  const copy: Copy = COPY[tag.startsWith('zh') ? 'zh' : 'en']
  const t = boundTranslator(props.t, copy)
  const [localOpen, setLocalOpen] = useState(false)
  const owner = typeof props.useDisclosure === 'function' ? props.useDisclosure() : null
  const open = owner !== null && typeof owner.expanded === 'boolean' ? owner.expanded : localOpen
  const toggle = owner !== null && typeof owner.toggle === 'function' ? owner.toggle : () => setLocalOpen(!localOpen)

  const state = phase !== 'result'
    ? (phase === 'preparing' ? 'preparing' : 'running')
    : block?.error?.code === 'interrupted'
      ? 'stopped'
      : block?.isError === true
        ? 'error'
        : 'ok'
  const running = phase !== 'result'
  const model = state === 'ok' ? normalizeSearchMeta(block?.meta) : null
  const query = argText(block, 'query')
  const scope = argText(block, 'path')
  // A path-only listing carries no query, and a collapsed row showing just `12/12`
  // says nothing about what was asked. Fall back to the scope, then to "every drive".
  const subject = query !== '' ? query : scope !== '' ? scope : copy.resultAllDrives
  const recorded = phase === 'result' ? resultText(block) : ''
  const failedMessage = state === 'error' || state === 'stopped' ? recorded.replace(/^Error:\s*/i, '').trim() : ''
  const notRunning = /not running|未运行|\bIPC\b/i.test(failedMessage)

  let summary = subject
  let suffix: string | null = null
  let tone: string | undefined
  if (running) {
    summary = subject
  } else if (state === 'error' || state === 'stopped') {
    summary = failedMessage === '' ? copy.resultFailed : firstLine(failedMessage)
    tone = 'error'
  } else if (model !== null) {
    summary = subject
    if (model.returned === 0) suffix = copy.resultNoMatches
    else suffix = `${formatCount(model.returned, tag)}/${formatCount(model.total, tag)}`
  }

  let body: unknown = null
  if (phase === 'result') {
    if (state === 'error' || state === 'stopped') {
      body = [
        h('div', { key: 'state', style: { ...BODY_LINE, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } },
          notRunning ? copy.resultNotRunning : copy.resultFailed),
        failedMessage === '' ? null : h('div', { key: 'message', style: { ...BODY_LINE, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } }, failedMessage),
        h('div', { key: 'hint', style: BODY_LINE }, copy.stateHint),
      ].filter(Boolean)
    } else if (model !== null) {
      const visible = model.rows.slice(0, CARD_ROW_DISPLAY)
      const metaLine = model.total === 1
        ? copy.resultMatchOne
        : t('resultMatches', { total: formatCount(model.total, tag) })
      const footer = visible.length < model.returned
        ? t('resultShowMore', { shown: formatCount(visible.length, tag), returned: formatCount(model.returned, tag) })
        : model.truncated
          ? copy.resultTruncated
          : ''
      body = [
        h('div', { key: 'meta', style: BODY_LINE }, `${metaLine} · ${formatCount(model.returned, tag)}`),
        visible.length === 0
          ? null
          : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
            visible.map((row, index) => h(HitLine, {
              key: `${index}:${row.path}`,
              row,
              openFile,
              t,
            }))),
        footer === '' ? null : h('div', { key: 'footer', style: BODY_LINE }, footer),
      ].filter(Boolean)
    } else {
      body = recorded === ''
        ? null
        : [h('div', { key: 'label', style: BODY_LINE }, copy.resultFallback), h('div', { key: 'text', style: BODY_LINE }, recorded)]
    }
  }

  const expandable = phase === 'result' && (model !== null || recorded !== '' || typeof inspect === 'function')
  const bodyId = callId === undefined ? undefined : `dsh-everything-body-${callId}`
  const rowProps: Record<string, unknown> = { style: ROW }
  if (expandable) {
    rowProps.role = 'button'
    rowProps.tabIndex = 0
    rowProps['aria-expanded'] = open ? 'true' : 'false'
    if (bodyId !== undefined) rowProps['aria-controls'] = bodyId
    rowProps.onClick = toggle
    rowProps.onKeyDown = (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
  }

  return h('div', { 'data-tool': 'find_files', 'data-state': state }, [
    h('div', { key: 'row', ...rowProps }, [
      h('span', { key: 'title', style: ROW_TITLE }, copy.resultTitle),
      h('span', { key: 'sep', style: SEP, 'aria-hidden': true }),
      h('span', { key: 'summary', style: { ...SUMMARY, ...(tone === 'error' ? { color: 'var(--dsw-alias-state-error-primary, #c0392b)' } : {}) }, title: summary }, summary),
      suffix === null ? null : h('span', { key: 'suffix', style: SUFFIX }, suffix),
    ]),
    open && h('div', { key: 'body', id: bodyId, style: CARD_BODY, role: 'group' }, [
      body,
      typeof inspect === 'function'
        ? h('button', {
            key: 'inspect',
            type: 'button',
            style: {
              alignSelf: 'flex-start',
              margin: '2px 0 0',
              padding: 0,
              border: 'none',
              background: 'none',
              color: 'var(--dsw-alias-label-tertiary, #6b7280)',
              font: 'inherit',
              fontSize: '11px',
              lineHeight: '16px',
              textDecoration: 'underline',
              cursor: 'pointer',
            },
            onClick: inspect,
          }, copy.resultInspect)
        : null,
    ]),
  ])
}

/** One hit line: name, dimmed parent path, and — for syntax results — size and date. */
function HitLine(props: { row: CardRow; openFile?: (path: string) => void; t: (key: string, params?: Record<string, unknown>) => string }) {
  const { row, openFile, t } = props
  const label = row.folder ? `${row.name}\\` : row.name
  const name = !row.folder && typeof openFile === 'function'
    ? h('button', {
        type: 'button',
        style: HIT_NAME,
        title: row.path,
        'aria-label': t('resultOpen', { name: row.name }),
        onClick: (event: { stopPropagation(): void }) => {
          event.stopPropagation()
          openFile(row.path)
        },
      }, label)
    : h('span', { style: { ...HIT_NAME, cursor: 'default' }, title: row.path }, label)
  const metaParts: string[] = []
  if (row.size !== undefined) {
    const size = formatBytes(row.size)
    if (size !== '') metaParts.push(size)
  }
  const date = formatModified(row.modified, detectLocaleTag())
  if (date !== '') metaParts.push(date)
  return h('div', { style: HIT_ROW }, [
    name,
    h('span', { key: 'path', style: HIT_PATH, title: parentPath(row.path) }, compactParentPath(parentPath(row.path))),
    metaParts.length === 0 ? null : h('span', { key: 'meta', style: HIT_META }, metaParts.join(' · ')),
  ])
}

/** The browser plugin context, narrowed to what these cards touch. */
interface ClientContext {
  /**
   * The locale service, read only for which language to use.
   *
   * `bind()` answers a lookup function (`t('key')`), never a copy table; the card
   * keeps its own literal copy so no lookup can come back undefined.
   */
  locale?: {
    register?(namespace: string, table: Record<string, unknown>): void
    bind?(namespace: string): unknown
    getSnapshot?(): unknown
  }
  get?(service: string): unknown
  slots: {
    inject(name: string, factory: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  effect(callback: () => () => void, label: string): void
}

/**
 * Pick the card's copy for one language.
 *
 * The returned table is always complete: both languages are written out in full
 * in this module, so no lookup can come back empty. That is deliberate — the
 * failure this replaced was a card whose every caption was `undefined` while its
 * inputs still held the right values.
 *
 * @param language - `zh` or `en`.
 * @returns the copy table for that language.
 */
export function copyFor(language: 'zh' | 'en'): Copy {
  return language === 'zh' ? COPY.zh : COPY.en
}

/**
 * Decide which language the cards should speak.
 *
 * The locale service is consulted only for this one fact. Its `bind()` returns a
 * lookup function rather than a copy table, and its snapshot shape is not part of
 * the cards' contract, so every read is defensive and every failure falls back to
 * the browser's own language before the default.
 *
 * @param ctx - the browser plugin context.
 * @returns the language to render in.
 */
export function activeLanguage(ctx: ClientContext): 'zh' | 'en' {
  const fromService = (): unknown => {
    try {
      const snapshot = ctx.locale?.getSnapshot?.() as { active?: unknown } | undefined
      const active = snapshot?.active
      return typeof active === 'string' ? active : (active as { id?: unknown } | undefined)?.id
    } catch {
      return undefined
    }
  }
  const candidates = [fromService(), typeof navigator === 'undefined' ? undefined : navigator.language]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    return candidate.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }
  // No signal at all: this plugin's primary audience, and the language of the
  // documentation the card mirrors.
  return 'zh'
}

/**
 * Find the settings form the Host actually serves for this bundle.
 *
 * `forms.get()` throws for an unknown namespace on some builds, and returns a
 * scope whose snapshot never becomes `ready` on others, so this returns the
 * first candidate that answers at all and lets the card render the
 * "not loaded" notice when none does.
 *
 * @param forms - the probed settings service.
 * @returns the bound scope, or undefined when this deployment serves none.
 */
function resolveSettingsScope(forms: { get(namespace: string): SettingsScope }): SettingsScope | undefined {
  for (const namespace of SETTINGS_NAMESPACE_CANDIDATES) {
    try {
      const scope = forms.get(namespace)
      if (scope !== undefined && scope !== null) return scope
    } catch {
      // An absent namespace is an answer, not a failure: try the next spelling.
    }
  }
  return undefined
}

/**
 * Narrow the probed settings service to the surface the card uses.
 * @param value - whatever `ctx.get('configForms')` answered.
 * @returns whether it can bind a namespace to a form scope.
 */
function isFormsService(value: unknown): value is { get(namespace: string): SettingsScope } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

/**
 * Register both halves of this browser plugin.
 *
 * The configuration card lives in `plugins.bundle.config`, keyed by this bundle's
 * package name, which is where the page shows a bundle's own configuration; the
 * `find_files` card lives in `tool.call.toolview`, keyed by the wire tool name.
 * Both slots and the `configForms` service are probed rather than declared in
 * `inject`, because a Cordis dependency gate is hard: an absent service would
 * keep `apply` from running at all. A deployment without them simply shows no
 * card while the `@` provider keeps working.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Resolve the copy to a COMPLETE literal table before a card ever renders.
  const copy = copyFor(activeLanguage(ctx))

  // `ctx.get` answers undefined instead of throwing for a service this
  // deployment does not provide. A missing `configForms` must NOT stop the card
  // from being registered: the card renders its own "unavailable" notice, which
  // is far more useful than a page that silently shows no custom card at all.
  const forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
  const settingsScope = () => (isFormsService(forms) ? resolveSettingsScope(forms) : undefined)

  const dispositions: Array<() => void> = []
  for (const slotName of ['plugins.bundle.config', 'plugins.row.config']) {
    // `plugins.bundle.config` is keyed by the PACKAGE name (the Plugins page
    // compares it against its own inventory), while `plugins.row.config` is
    // keyed by `<package>#<row id>`. The settings namespace is neither — it is
    // the Loader entry id, which is why the card resolves it separately.
    const key = slotName === 'plugins.bundle.config' ? NAMESPACE : `${NAMESPACE}#file-reference-everything`
    try {
      dispositions.push(
        ctx.slots.inject(slotName, () =>
          ctx.slots.register(
            {
              name: slotName,
              key,
              priority: 30,
              inject: () => ({ t: copy, settingsScope: settingsScope() }),
            },
            EverythingCard,
          ),
        ),
      )
    } catch (error) {
      // One slot failing must not cost the other, and the failure has to be
      // visible: a missing card is otherwise indistinguishable from a broken one.
      console.error(`[dsh-everything] card slot "${slotName}" failed to register:`, error)
    }
  }

  // One card component serves both tools: the persisted projection decides whether
  // a row also carries size and date, so the render path is shared.
  for (const key of ['find_files', 'everything_search']) {
    try {
      dispositions.push(
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key, locale: NAMESPACE },
            guarded(FindFilesCard),
          ),
        ),
      )
    } catch (error) {
      console.error(`[dsh-everything] result card slot "${key}" failed to register:`, error)
    }
  }

  ctx.effect(
    () => () => {
      for (const dispose of dispositions) dispose()
      dispositions.length = 0
    },
    'dsh-everything: cards',
  )
}

/**
 * Wrap a card in an error boundary.
 *
 * A throwing view blanks its slot entry with no generic fallback, so every card
 * renders inside this boundary: a crash degrades to one plain row that still
 * names the tool. Implemented with `React.Component` reached through the module
 * table's `react` export, because this half is built without JSX.
 *
 * @param Card - the card component.
 * @returns a component that renders `Card` or a one-line fallback.
 */
function guarded(Card: (props: ToolCardProps) => unknown) {
  class CardBoundary extends Component<{ cardProps?: ToolCardProps; children?: unknown }> {
    override state: { failed: boolean } = { failed: false }

    static getDerivedStateFromError() {
      return { failed: true }
    }

    override render() {
      if (this.state.failed !== true) return this.props.children
      const cardProps = this.props.cardProps ?? {}
      let detail = ''
      try {
        detail = firstLine(resultText(cardProps.block).replace(/^Error:\s*/i, ''))
      } catch {
        detail = ''
      }
      return h('div', { 'data-tool': 'find_files', 'data-state': 'error' }, [
        h('div', { key: 'row', style: ROW }, [
          h('span', { key: 'title', style: ROW_TITLE }, copyFor(detectLocaleTag().startsWith('zh') ? 'zh' : 'en').resultTitle),
          detail === '' ? null : h('span', { key: 'detail', style: SUMMARY }, detail),
        ]),
      ])
    }
  }
  return function GuardedCard(props: ToolCardProps) {
    return h(CardBoundary, { cardProps: props }, h(Card, props))
  }
}

export { COPY, NAMESPACE, SETTINGS_NAMESPACE_CANDIDATES, parseNames as parseExcludedNames }
