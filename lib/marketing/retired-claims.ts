// lib/marketing/retired-claims.ts — claims the public site stopped making on
// 2026-10-04 because the code says otherwise, as one list the copy contract
// (tests/marketing-claims-contract.test.ts) and the editorial readers share.
//
// The code-owned copy was corrected in the catalogues, but three admin stores
// feed public pages too — marketing_seo_pages (meta descriptions),
// marketing_pages (summaries and SEO) and marketing_aeo_questions (the
// Knowledge Center answers on /mobile, /faq and every blog article) — and their
// rows were seeded by migration 0229 before the correction. Production still
// served "an installable app with native iOS and Android companions" on /mobile
// after the catalogue fix had shipped, from those rows. They are editorial and
// admin-editable, so a corrected row can drift back; the readers therefore
// refuse a row that states one of these claims (the code fallback, or no
// answer, is shown instead) rather than trusting every row to have been fixed.
export const RETIRED_CLAIMS: readonly RegExp[] = Object.freeze([
  // No store-listed native apps: the Expo companion is unpublished.
  /native (iOS|Android)|native companion|companion apps/i,
  // No free plan for a new family: an expired trial locks
  // (lib/server/entitlement.ts).
  /free (starter )?plan\b/i,
  // The trial is Family Basic, and Basic's AI allowance is unmetered.
  /10 AI requests|ten assistant requests/i,
  // No bounty and no acknowledgments page: both are "planned" in
  // lib/marketing/trust-ledger.ts.
  /rewards researchers|acknowledge?ments page/i,
  // Apple and Outlook arrive as published links, not two-way sync.
  /two-way sync with Google, Apple/i,
  // There is no offline write queue.
  /changes will sync|sync the moment you/i,
]);

/** True when any of the texts states a claim the site no longer makes. */
export function statesARetiredClaim(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => typeof text === 'string' && RETIRED_CLAIMS.some((claim) => claim.test(text)));
}
