/**
 * Version of the term derivation below. Stored with each new index entry so that a later
 * change can tell which entries were derived by an older rule.
 */
export const SEARCH_TERMS_VERSION = 2;

// The prolonged sound mark has Script=Common, so it is named explicitly: without it a
// katakana word such as a company name would be cut at every long vowel.
const JAPANESE = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー';
const RUNS = new RegExp(`([${JAPANESE}]+)|((?:(?![${JAPANESE}])[\\p{L}\\p{N}])+)`, 'gu');

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
      tokens.add(other);
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

/** Share of the query's weighted terms a record must contain before terms count as a match. */
export const MIN_TERM_COVERAGE = 0.15;

/**
 * Weights each query term by how rare it is among the candidates and returns, per candidate,
 * the matched share of the query's total weight (0 to 1). A term that many records contain
 * therefore counts for little, and a query term that no record contains still lowers the share.
 */
export function termCoverage(
  queryTerms: readonly string[],
  candidateTerms: readonly ReadonlySet<string>[],
): number[] {
  if (queryTerms.length === 0) return candidateTerms.map(() => 0);
  const total = candidateTerms.length;
  const weights = queryTerms.map((term) => {
    let containing = 0;
    for (const terms of candidateTerms) if (terms.has(term)) containing += 1;
    return Math.log(1 + total / Math.max(containing, 0.5));
  });
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  return candidateTerms.map((terms) => {
    let matched = 0;
    queryTerms.forEach((term, index) => {
      if (terms.has(term)) matched += weights[index]!;
    });
    return weightSum === 0 ? 0 : matched / weightSum;
  });
}
