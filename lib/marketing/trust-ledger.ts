// lib/marketing/trust-ledger.ts — the Trust Center's evidence ledger.
//
// The public /security page used to carry certification and uptime badges that
// nothing in this repository could back. This registry replaces them with rows
// that say, for each claim, exactly what kind of claim it is:
//
//   verified  — enforced in code AND pinned by an automated test in this repo.
//               Every such row lists the test files, and
//               tests/marketing-trust-ledger.test.ts fails if one goes missing.
//   in_place  — we do it today, but the evidence is a policy or a process
//               rather than a test that runs on every change.
//   provider  — held by the infrastructure Bubaly runs on (database, hosting),
//               not audited for Bubaly itself.
//   planned   — on the roadmap. No badge until it exists.
//
// Pure module: no React, no server imports, so the honesty test can import it
// directly and a client component could render it if one ever needed to. Copy
// lives in the catalogue under trustCenter.row*, never here.

export type TrustLedgerStatus = 'verified' | 'in_place' | 'provider' | 'planned';

export const TRUST_LEDGER_STATUSES: readonly TrustLedgerStatus[] = ['verified', 'in_place', 'provider', 'planned'];

export type TrustLedgerRow = {
  /** Stable id; the rendered row carries id="ledger-<key>". */
  key: string;
  /** Catalogue key for the row's label (trustCenter.row*). */
  labelKey: string;
  status: TrustLedgerStatus;
  /**
   * For 'verified': repo-relative test paths that assert the claim. An https
   * URL is also accepted, for evidence that lives outside the repo (an audit
   * report, a published pen-test summary) — the only way a roadmap row may
   * ever become 'verified'.
   */
  evidence?: string[];
};

/** Rows whose claim is a roadmap item today; they may not be 'verified' without an external evidence URL. */
export const ROADMAP_ROW_KEYS = ['soc2_bubaly', 'pen_test', 'bug_bounty', 'status_page', 'data_region'] as const;

/** The date a person last read every row against the code. Shown on the page. */
export const LAST_REVIEWED = '2026-09-07';

export const TRUST_LEDGER: TrustLedgerRow[] = [
  {
    key: 'rls',
    labelKey: 'trustCenter.rowRls',
    status: 'verified',
    evidence: [
      'tests/rls-isolation-sweep.test.ts',
      'tests/tenant-isolation-rls.test.ts',
      'tests/sql-security-contract.test.ts',
    ],
  },
  {
    key: 'trust_ledger_append_only',
    labelKey: 'trustCenter.rowLedgerAppendOnly',
    status: 'verified',
    evidence: ['tests/0260-trust-ledger-lockdown.test.ts'],
  },
  {
    // tests/trust-engine.test.ts asserts `require_approval` for an AI actor
    // automating in `medical` (a HIGH_STAKES_AI_DOMAINS entry) and for a teen in
    // `driving`; tests/tool-risk.test.ts asserts the risk tier never loosens
    // that gate for finances/banking; tests/assistant-trust-wrapper.test.ts
    // asserts a require_approval decision defers the write to a parent; and
    // tests/marketing-trust-ledger.test.ts asserts it for EVERY listed domain.
    key: 'high_stakes_asks',
    labelKey: 'trustCenter.rowHighStakes',
    status: 'verified',
    evidence: [
      'tests/trust-engine.test.ts',
      'tests/tool-risk.test.ts',
      'tests/assistant-trust-wrapper.test.ts',
      'tests/marketing-trust-ledger.test.ts',
    ],
  },
  {
    key: 'approvals_expire',
    labelKey: 'trustCenter.rowApprovalsExpire',
    status: 'verified',
    evidence: ['tests/approval-expiry.test.ts'],
  },
  {
    key: 'csp',
    labelKey: 'trustCenter.rowCsp',
    status: 'verified',
    evidence: ['tests/csp-header.test.ts', 'tests/e2e/csp.spec.ts'],
  },
  { key: 'audit_log', labelKey: 'trustCenter.rowAudit', status: 'in_place' },
  // Export is by request (privacy policy, "Your rights"); items and member
  // profiles are deleted in the app, whole accounts on request. The label says
  // "on request" for that reason — a self-serve export does not exist yet.
  { key: 'export_delete', labelKey: 'trustCenter.rowExport', status: 'in_place' },
  { key: 'no_training', labelKey: 'trustCenter.rowNoTraining', status: 'in_place' },
  { key: 'tls', labelKey: 'trustCenter.rowTls', status: 'provider' },
  { key: 'at_rest', labelKey: 'trustCenter.rowAtRest', status: 'provider' },
  { key: 'soc2_providers', labelKey: 'trustCenter.rowSoc2Provider', status: 'provider' },
  { key: 'soc2_bubaly', labelKey: 'trustCenter.rowSoc2Bubaly', status: 'planned' },
  { key: 'pen_test', labelKey: 'trustCenter.rowPenTest', status: 'planned' },
  { key: 'bug_bounty', labelKey: 'trustCenter.rowBounty', status: 'planned' },
  { key: 'status_page', labelKey: 'trustCenter.rowStatusPage', status: 'planned' },
  { key: 'data_region', labelKey: 'trustCenter.rowDataRegion', status: 'planned' },
];

/** The catalogue key for a status pill's label ('trustCenter.statusVerified', …). */
export function statusLabelKey(status: TrustLedgerStatus): string {
  return STATUS_LABEL_KEY[status];
}

/** The catalogue key for a status pill's one-line explanation. */
export function statusHelpKey(status: TrustLedgerStatus): string {
  return `${statusLabelKey(status)}Help`;
}

// Whole keys, not the suffix half of a template. `trustCenter.status${suffix}`
// built a key no grep could find, and its halves — 'Verified', 'Planned' —
// read as copy to anything that scans for untranslated English.
const STATUS_LABEL_KEY: Record<TrustLedgerStatus, string> = {
  verified: 'trustCenter.statusVerified',
  in_place: 'trustCenter.statusInPlace',
  provider: 'trustCenter.statusProvider',
  planned: 'trustCenter.statusPlanned',
};

export function isEvidenceUrl(evidence: string): boolean {
  return /^https:\/\//.test(evidence);
}
