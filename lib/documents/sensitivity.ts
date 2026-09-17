// What counts as "not for the children" in a document — the one definition,
// shared by every layer that has to decide.
//
// It lives here rather than in `lib/services/documents` because that module is
// `server-only` and the Files hub runs in the browser. A rule the client
// cannot see is a rule the client cannot honour, and the client is exactly
// where a person is about to upload a passport into the Secure Vault.
//
// `public.is_sensitive_document(is_secure, category)` is the same rule again in
// SQL, and `tests/document-vault-boundary.test.ts` fails if the two drift. Two
// copies is the minimum: the database has to hold the line for callers that
// never run this code at all.
//
// ── why this matches TOKENS, not the whole string ───────────────────────────
//
// `category` is a FREE-TEXT folder name the person types
// (components/modules/documents-module.tsx), and the upload path never sets
// `is_secure`. So the category IS the boundary for anything uploaded through
// Documents — and until 0312 the rule was exact membership of a 17-word list.
// Measured against the folder names a parent actually types:
//
//   'medical'          -> sensitive        'Medical Records'  -> NOT sensitive
//   'tax'              -> sensitive        'Tax Returns'      -> NOT sensitive
//   'bank'             -> sensitive        'Bank Statements'  -> NOT sensitive
//   'passport'         -> sensitive        'Passports & IDs'  -> NOT sensitive
//   'will' / 'estate'  -> sensitive        'Wills & Estate'   -> NOT sensitive
//   'health'/'insurance' -> sensitive      'Health Insurance' -> NOT sensitive
//
// Every natural plural or two-word folder name defeated it, including two whose
// every word was already on the list. So the match is now per WORD, with a
// trailing "s" stripped, plus a short list of phrases no single word catches.
//
// Over-classification is the safe direction here and is chosen deliberately: a
// gym membership filed under "Health Club" becoming adults-only is a smaller
// harm than a child reading a diagnosis. Under-classification is what this
// migration exists to end.
//
// It remains a list, and a list is still the thing that let this through. What
// changed is that the list now matches the language people write in.

/** Words that make a document adults-only when they appear in its category. */
export const SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set([
  // the original seventeen
  'legal', 'medical', 'health', 'financial', 'finance', 'tax', 'taxes', 'insurance',
  'passport', 'passports', 'id', 'identity', 'visa', 'bank', 'banking', 'will', 'estate',
  // identity and status
  'ssn', 'birth', 'marriage', 'divorce', 'citizenship', 'naturalization', 'immigration',
  'custody', 'guardianship', 'attorney',
  // money
  'mortgage', 'deed', 'loan', 'payroll', 'salary', 'pension', 'retirement',
  'investment', 'brokerage',
  // health
  'prescription', 'diagnosis', 'therapy', 'psychiatric', 'medicare', 'medicaid',
  'license', 'licence',
]);

/** Phrases no single word above would catch on its own. */
export const SENSITIVE_PHRASES: readonly string[] = [
  'social security', 'green card', 'credit card',
];

/** Lowercase, and reduce every run of non-alphanumerics to one space. */
export function normalizeCategory(category: string | null | undefined): string {
  return (category ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True when a category alone makes a document adults-only. */
export function isSensitiveCategory(category: string | null | undefined): boolean {
  const normalized = normalizeCategory(category);
  if (!normalized) return false;
  if (SENSITIVE_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
  return normalized.split(' ').some((token) => {
    if (SENSITIVE_CATEGORIES.has(token)) return true;
    // One trailing "s", so "Wills" reaches "will" — but "Kids" only ever
    // reaches "kid", never the bare "id" that a substring match would hit.
    return token.length > 1 && token.endsWith('s') && SENSITIVE_CATEGORIES.has(token.slice(0, -1));
  });
}

export function isSensitiveDocument(doc: { is_secure: boolean | null; category: string | null }): boolean {
  return Boolean(doc.is_secure) || isSensitiveCategory(doc.category);
}
