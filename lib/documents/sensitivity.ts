// What counts as "not for the children" in a document — the one definition,
// shared by every layer that has to decide.
//
// It lives here rather than in `lib/services/documents` because that module is
// `server-only` and the Files hub runs in the browser. A rule the client
// cannot see is a rule the client cannot honour, and the client is exactly
// where a person is about to upload a passport into the Secure Vault.
//
// 0266's `public.is_sensitive_document(is_secure, category)` is the same list
// again in SQL, and `tests/document-vault-boundary.test.ts` fails if the two
// drift. Two copies is the minimum: the database has to hold the line for
// callers that never run this code at all.

/** Categories treated as sensitive regardless of the Secure Vault flag. */
export const SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set([
  'legal', 'medical', 'health', 'financial', 'finance', 'tax', 'taxes', 'insurance',
  'passport', 'passports', 'id', 'identity', 'visa', 'bank', 'banking', 'will', 'estate',
]);

/** True when a category alone makes a document adults-only. */
export function isSensitiveCategory(category: string | null | undefined): boolean {
  return SENSITIVE_CATEGORIES.has((category ?? '').trim().toLowerCase());
}

export function isSensitiveDocument(doc: { is_secure: boolean | null; category: string | null }): boolean {
  return Boolean(doc.is_secure) || isSensitiveCategory(doc.category);
}
