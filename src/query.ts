/**
 * The Everything query syntax this plugin emits.
 *
 * Everything parses the query string on the service side, so these builders are
 * pure text assembly — testable without an index, a DLL, or a Harness install.
 * Four properties of that syntax shape every builder:
 *
 * 1. **A space separates terms; each term is AND-ed.** A literal fragment
 *    containing a space must therefore be spelled with `?` (one character) rather
 *    than quote the whole string, which Everything reads as a phrase filter with
 *    different semantics.
 * 2. **Everything indexes filenames.** A bare term matches the name only, which is
 *    also the fast path. Scope is supplied by a `path:` term (for a subtree) or
 *    `parent:` (for one directory's children), never by widening a term to the
 *    full path.
 * 3. **`^` is the escape character**, and `& | < > "` are operators.
 * 4. **A folder exclusion must reach the contents.** `!path:Library` matches that
 *    substring anywhere in the path (so `Library.txt` and `LibraryBeta` go too),
 *    while `!folder:Library` matches the folder row but not its children. The
 *    form that prunes the subtree is `!path:*\Library\*`.
 *
 * @module dsh-everything/query
 */

/**
 * Escape one literal fragment so Everything reads it as text rather than syntax.
 *
 * A space is represented by `?`, which matches exactly one character: the fragment
 * is fixed-length, so `?` is an exact substitute rather than a widening.
 *
 * @param text - literal text typed by the user.
 * @returns the escaped fragment, free of term separators.
 */
export function escapeTerm(text: string): string {
  return text
    .replaceAll(' ', '?')
    .replace(/([\\&|<>^"])/g, (character) => `^${character}`)
}

/**
 * Build the term that matches `query` as a case-insensitive contiguous substring
 * of an indexed **file name**.
 *
 * This is the first tier: contiguous substring is the overwhelmingly common
 * intent, and name matching is what the index answers fastest.
 *
 * @param query - text typed after `@`.
 * @returns an Everything term containing no spaces.
 */
export function contiguousTerm(query: string): string {
  return `*${escapeTerm(query)}*`
}

/**
 * Build the terms that prune a folder subtree from a query.
 *
 * Everything prunes while it walks the index, so an excluded tree costs nothing at
 * query time — unlike filtering the returned rows, which spends the candidate
 * budget on rows that are thrown away afterwards.
 *
 * The last form in the module comment is the one emitted here: the leading `*`
 * makes the segment match at any depth, and the trailing `\*` is what actually
 * reaches the contents. `?` behaves inconsistently inside a path segment, so the
 * configuration card points at `*` rather than promising more.
 *
 * @param patterns - folder-name patterns (`Library`, `Lib*`) to prune.
 * @returns one term per pattern.
 */
export function folderExclusionTerms(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => `!path:*\\${escapeTerm(pattern)}\\*`)
}

/**
 * Build the terms that exclude file names from a query.
 *
 * Everything treats a bare `!*.meta` as an exclusion pattern over the name, so a
 * leading `!` is enough — wrapping it in separators would make it a path test and
 * match nothing.
 *
 * @param patterns - file-name patterns (`*.meta`) to prune.
 * @returns one term per pattern.
 */
export function fileExclusionTerms(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => `!${pattern}`)
}

/**
 * Build the term for a directory listing, optionally narrowed by a fragment.
 *
 * `**` is Everything's "match every name", so a blank fragment asks for the
 * directory's whole contents while a non-blank one is answered by the index
 * rather than by the caller. That distinction is what keeps a listing correct:
 * the page is truncated, so filtering a truncated page in the caller silently
 * loses entries whenever a directory holds more children than the page size, and
 * the lost entries are the ones whose names sort last.
 *
 * @param fragment - text typed after the final `/`, possibly empty.
 * @returns an Everything term containing no spaces.
 */
export function listingTerm(fragment: string): string {
  return fragment === '' ? '**' : contiguousTerm(fragment)
}

/**
 * Build the term that matches `query` as a case-insensitive **subsequence** of an
 * indexed file name: every character in order, gaps allowed.
 *
 * `filedock` therefore matches `FileDock`-style names where a contiguous search
 * would miss the camel-case gap. Everything answers this from the index rather
 * than a scan, so it is the affordable fuzzy tier.
 *
 * @param query - text typed after `@`.
 * @returns an Everything term containing no spaces.
 */
export function subsequenceTerm(query: string): string {
  const characters = [...query]
  if (characters.length === 0) return '*'
  return `*${characters.map((character) => escapeTerm(character)).join('*')}*`
}

/**
 * Build the term that confines a query to one folder and its subfolders.
 *
 * `path:` tests the full path for the given text, so this is a scope rather than
 * a filename filter. It is a substring test, not a prefix test: `path:C:\work`
 * also matches `C:\workspace\...`. Callers therefore still re-check every row
 * against the root (see `relativeToRoot` and `toEntries`), and the query's own
 * page budget is the only thing the looser match can spend.
 *
 * The path is quoted because it may contain spaces; inside the quotes `^` is
 * doubled so a literal caret in a directory name is not read as an escape.
 *
 * @param directory - the folder to scope to.
 * @returns an Everything term that scopes to that folder and its children.
 */
export function pathTerm(directory: string): string {
  return `path:"${directory.replaceAll('^', '^^')}"`
}

/**
 * Build the term that matches the direct children of one folder.
 *
 * `parent:` is the query-level counterpart of `es.exe -parent`: it tests the
 * immediate parent rather than the whole path, so listing a folder costs one
 * indexed lookup per level instead of a scan whose page size decides which
 * children are visible.
 *
 * The path is quoted because it may contain spaces. Inside the quotes `^` is
 * doubled so a literal caret in a directory name is not read as an escape.
 *
 * @param directory - absolute folder path.
 * @returns an Everything term matching that folder's direct children.
 */
export function parentTerm(directory: string): string {
  return `parent:"${directory.replaceAll('^', '^^')}"`
}
