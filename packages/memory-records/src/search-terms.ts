/**
 * Version of the term derivation below. Stored with each new index entry so that a later
 * change can tell which entries were derived by an older rule.
 */
export const SEARCH_TERMS_VERSION = 2;

// The prolonged sound mark has Script=Common, so it is named explicitly: without it a
// katakana word such as a company name would be cut at every long vowel.
const JAPANESE = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー';
const RUNS = new RegExp(`([${JAPANESE}]+)|((?:(?![${JAPANESE}])[\\p{L}\\p{N}])+)`, 'gu');

const MAX_TERM_LENGTH = 128;

/** Case- and width-insensitive form used to compare names, terms and query text. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('und');
}

/**
 * Derives the lexical terms of a text. A run of Japanese characters yields its character
 * bigrams (or the single character); any other run of letters and digits is one term. Runs are
 * cut where the script changes, so a Latin name written directly before Japanese text is a term
 * of its own.
 */
export function tokenizeSearchText(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of normalizeSearchText(text).matchAll(RUNS)) {
    const [, japanese, other] = match;
    if (other !== undefined) {
      // A run this long is an encoded value, not a word anyone searches for.
      if (other.length <= MAX_TERM_LENGTH) tokens.add(other);
      continue;
    }
    const points = [...(japanese ?? '')];
    if (points.length === 1) tokens.add(points[0]!);
    for (let index = 0; index + 1 < points.length; index += 1)
      tokens.add(`${points[index]}${points[index + 1]}`);
  }
  return [...tokens].sort();
}

/** The text of a record that recall matches against. */
export function searchableText(record: {
  readonly title: string;
  readonly statement: string;
  readonly subjectIds: readonly string[];
  readonly aliases: readonly { readonly value: string }[];
}): string {
  return [
    record.title,
    record.statement,
    ...record.subjectIds,
    ...record.aliases.map((alias) => alias.value),
  ].join(' ');
}

export type RecallMatchReason = 'record-id' | 'subject' | 'alias' | 'terms' | 'semantic';

/**
 * How many results supported by similarity alone are returned next to results that a name or
 * term of the query supports. Without any such support, similarity results are not limited.
 */
export const MAX_SEMANTIC_ONLY_BESIDE_MATCHES = 2;

/** True when something other than similarity matched: a record ID, subject, alias or terms. */
export function hasNameOrTermMatch(matched: readonly RecallMatchReason[]): boolean {
  return matched.some((reason) => reason !== 'semantic');
}

/** Share of the query's weighted terms a record must contain before terms count as a match. */
export const MIN_TERM_COVERAGE = 0.15;

/**
 * Weights each query term by how rare it is among the given term sets. A term that many records
 * contain counts for little; a term that none contains gets the largest weight, so it still
 * lowers the matched share of a query.
 */
export function termWeights(
  queryTerms: readonly string[],
  termSets: readonly ReadonlySet<string>[],
): number[] {
  const total = termSets.length;
  return queryTerms.map((term) => {
    let containing = 0;
    for (const terms of termSets) if (terms.has(term)) containing += 1;
    return Math.log(1 + total / Math.max(containing, 0.5));
  });
}

/** The matched share (0 to 1) of the query's total weight that one term set contains. */
export function weightedShare(
  queryTerms: readonly string[],
  weights: readonly number[],
  terms: ReadonlySet<string>,
): number {
  let matched = 0;
  let sum = 0;
  queryTerms.forEach((term, index) => {
    const weight = weights[index] ?? 0;
    sum += weight;
    if (terms.has(term)) matched += weight;
  });
  return sum === 0 ? 0 : matched / sum;
}

/** {@link termWeights} over the candidates themselves, then each candidate's {@link weightedShare}. */
export function termCoverage(
  queryTerms: readonly string[],
  candidateTerms: readonly ReadonlySet<string>[],
): number[] {
  const weights = termWeights(queryTerms, candidateTerms);
  return candidateTerms.map((terms) => weightedShare(queryTerms, weights, terms));
}

const NAME_SEPARATORS = /[\s,.;:!?、。・「」『』（）()[\]<>"'/|]+/u;
const SCRIPT_RUNS =
  /[\p{Script=Katakana}\u30fc]+|\p{Script=Han}+|\p{Script=Hiragana}+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc])[\p{L}\p{N}])+/gu;
const MAX_NAME_CANDIDATES = 40;

/**
 * Strings in a query that may be the name of a subject, to be looked up one by one in the alias
 * table: the query itself, its space-separated parts and runs of two or three of them, and, for
 * text written without spaces, each run of one script, since a name in katakana or kanji is
 * usually followed by hiragana.
 */
export function nameCandidates(query: string): string[] {
  const candidates = new Set<string>();
  const add = (value: string): void => {
    const normalized = normalizeSearchText(value).trim().replace(/\s+/gu, ' ');
    if ([...normalized].length >= 2 && candidates.size < MAX_NAME_CANDIDATES)
      candidates.add(normalized);
  };
  add(query);
  const parts = query.split(NAME_SEPARATORS).filter((part) => part !== '');
  for (let size = 3; size >= 1; size -= 1)
    for (let start = 0; start + size <= parts.length; start += 1)
      add(parts.slice(start, start + size).join(' '));
  for (const part of parts)
    for (const run of part.match(SCRIPT_RUNS) ?? [])
      if (!/^\p{Script=Hiragana}+$/u.test(run)) add(run);
  return [...candidates];
}

/**
 * At most `limit` terms of a query for an index lookup, the most telling first: whole words of
 * other scripts before Japanese bigrams, and longer before shorter.
 */
export function lookupTerms(query: string, limit: number): string[] {
  const terms = tokenizeSearchText(query);
  const isBigram = (term: string): boolean =>
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]{1,2}$/u.test(term);
  const hiragana = (term: string): number => (term.match(/\p{Script=Hiragana}/gu) ?? []).length;
  return [...terms]
    .sort(
      (left, right) =>
        Number(isBigram(left)) - Number(isBigram(right)) ||
        hiragana(left) - hiragana(right) ||
        right.length - left.length ||
        left.localeCompare(right),
    )
    .slice(0, limit);
}
