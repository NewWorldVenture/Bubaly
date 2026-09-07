import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LAST_REVIEWED,
  ROADMAP_ROW_KEYS,
  TRUST_LEDGER,
  TRUST_LEDGER_STATUSES,
  statusHelpKey,
  statusLabelKey,
} from '@/lib/marketing/trust-ledger';
import { HIGH_STAKES_AI_DOMAINS, ROLE_DEFAULTS, evaluateAction, type Actor } from '@/lib/trust/engine';
import { HANDLED_PUBLIC_MIN, handledNote } from '@/lib/marketing/format';

/** A translator stand-in: returns the key, so the assertions read the shape, not the copy. */
const identity = (key: string) => key;

// The Trust Center's honesty guard.
//
// The old /security page carried an annual SOC 2 audit, HIPAA, a bug bounty,
// a 99.99% SLA, HSM-managed keys and a status page — none of which anything in
// this repository could back. The rewrite replaced them with a ledger whose
// every row says what KIND of claim it is, and this file is what stops the
// old claims from drifting back in: through the page, through a catalogue
// value the page renders, or through a 'verified' badge with nothing behind it.

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const page = read('app/(marketing)/security/page.tsx');
const component = read('components/marketing/trust-ledger.tsx');
const en = JSON.parse(read('lib/i18n/messages/en-US.json')) as Record<string, string>;

const RETIRED_CLAIMS = [
  'Audited annually',
  '99.99%',
  'public audits',
  'HSM',
  'Certificate pinning',
  'Column-level',
  'independently audited',
  'status.bubaly.com',
  'COMPLIANCE_BADGES',
  'HIPAA',
  'SOC 2 Type II',
  'ISO 27018',
  'Bank-Level',
];

/** Every catalogue key the file renders through t('…'), with a given prefix. */
function keysUsed(source: string, prefix: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/t\('([A-Za-z0-9_.]+)'\)/g)) {
    if (match[1].startsWith(prefix)) found.add(match[1]);
  }
  // Module-level data arrays keep their keys in `labelKey: '…'` beside the
  // English label; those render through t(x.labelKey) and count too.
  for (const match of source.matchAll(/labelKey:\s*'([A-Za-z0-9_.]+)'/g)) {
    if (match[1].startsWith(prefix)) found.add(match[1]);
  }
  return [...found];
}

describe('the trust ledger registry', () => {
  it('uses only the four statuses', () => {
    for (const row of TRUST_LEDGER) {
      expect(TRUST_LEDGER_STATUSES, row.key).toContain(row.status);
    }
  });

  it('has unique keys and a catalogue label for every row', () => {
    const keys = TRUST_LEDGER.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of TRUST_LEDGER) {
      expect(en[row.labelKey], row.key).toBeTruthy();
    }
  });

  it('backs every verified row with at least one test that exists on disk', () => {
    for (const row of TRUST_LEDGER.filter((r) => r.status === 'verified')) {
      const evidence = row.evidence ?? [];
      expect(evidence.length, row.key).toBeGreaterThan(0);
      const onDisk = evidence.filter((path) => path.startsWith('tests/') && existsSync(resolve(process.cwd(), path)));
      expect(onDisk.length, `${row.key}: ${evidence.join(', ')}`).toBeGreaterThan(0);
    }
  });

  it('cites only paths that exist or https URLs, never a dangling reference', () => {
    for (const row of TRUST_LEDGER) {
      for (const item of row.evidence ?? []) {
        const ok = /^https:\/\//.test(item) || existsSync(resolve(process.cwd(), item));
        expect(ok, `${row.key}: ${item}`).toBe(true);
      }
    }
  });

  it.each([...ROADMAP_ROW_KEYS])('%s is never verified without external evidence', (key) => {
    const row = TRUST_LEDGER.find((r) => r.key === key);
    expect(row, key).toBeTruthy();
    if (row?.status === 'verified') {
      expect((row.evidence ?? []).some((item) => /^https:\/\//.test(item)), key).toBe(true);
    }
  });

  it('never mentions HIPAA', () => {
    for (const row of TRUST_LEDGER) {
      expect(row.key).not.toMatch(/hipaa/i);
      expect(row.labelKey).not.toMatch(/hipaa/i);
      expect(en[row.labelKey]).not.toMatch(/hipaa/i);
    }
  });

  it('records the date a person last reviewed it', () => {
    expect(LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(LAST_REVIEWED))).toBe(false);
  });

  it('has a label and a help line in the catalogue for each status', () => {
    for (const status of TRUST_LEDGER_STATUSES) {
      expect(en[statusLabelKey(status)], status).toBeTruthy();
      expect(en[statusHelpKey(status)], status).toBeTruthy();
    }
  });
});

describe('the high_stakes_asks row is true of the engine', () => {
  // A 'verified' badge for "money, health and documents always ask a parent"
  // means the engine returns require_approval for an AI actor automating in
  // every domain the page lists — the same list the page renders.
  const bubaly: Actor = { kind: 'ai_agent', id: 'bubaly', role: 'parent' };

  it.each(HIGH_STAKES_AI_DOMAINS)('%s always asks a parent, even when the AI acts for one', (domain) => {
    const decision = evaluateAction({ actor: bubaly, domain, capability: 'automate' });
    expect(decision.effect).toBe('require_approval');
  });

  it('stays verified only while that holds', () => {
    const row = TRUST_LEDGER.find((r) => r.key === 'high_stakes_asks');
    expect(row?.status).toBe('verified');
    expect(row?.evidence).toContain('tests/trust-engine.test.ts');
  });

  it('the role table says a child\'s actions are reviewed, as ROLE_DEFAULTS does', () => {
    expect(ROLE_DEFAULTS.child.automationTrusted).toBe(false);
    expect(page).toContain('ROLE_DEFAULTS[role].automationTrusted');
    expect(page).toContain("t('trustCenter.automationNeedsParent')");
  });
});

describe('the /security page', () => {
  it('renders the AI trust section and the ledger', () => {
    expect(page).toContain('id="ai-trust"');
    expect(page).toContain('<TrustLedger');
    expect(page).toContain('path="/security"');
  });

  it('renders the always-asks list from HIGH_STAKES_AI_DOMAINS, not from retyped copy', () => {
    expect(page).toContain('highStakesGroups');
    expect(page).toContain('trustDomainKey');
    for (const domain of HIGH_STAKES_AI_DOMAINS) {
      expect(page, `literal '${domain}'`).not.toContain(`'${domain}'`);
      expect(en[`trustDomains.${domain}`], domain).toBeTruthy();
    }
  });

  it('uses the honest metadata keys', () => {
    expect(page).toContain("t('security.trustCenterMetaTitle')");
    expect(page).toContain("t('security.honestDescription')");
  });

  it.each(RETIRED_CLAIMS)('no longer contains %s', (claim) => {
    expect(page).not.toContain(claim);
    expect(component).not.toContain(claim);
  });

  it('shows the handled aggregate only through handledNote, which hides it below the floor', () => {
    expect(page).toContain('handledNote(t, stats.handledCompleted)');
    // No hand-rolled formatting of the real count: the floor lives in one place.
    expect(page).not.toContain('formatHandled(');
    expect(handledNote(identity, HANDLED_PUBLIC_MIN - 1)).toBe('');
    expect(handledNote(identity, HANDLED_PUBLIC_MIN)).not.toBe('');
  });

  it.each(RETIRED_CLAIMS)('renders no security.* or trustCenter.* value containing %s', (claim) => {
    const keys = [...keysUsed(page, 'security.'), ...keysUsed(page, 'trustCenter.'), ...keysUsed(component, 'trustCenter.')];
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(en[key], `${key} is missing from en-US`).toBeTruthy();
      expect(en[key], key).not.toContain(claim);
    }
  });

  it('no longer renders the retired hero keys', () => {
    expect(page).not.toContain('security.enterpriseGradeSecurity');
    expect(page).not.toContain('security.builtWithSameStandards');
    expect(page).not.toContain('security.certifiedCompliantTrusted');
    expect(page).not.toContain('security.annualPenetrationTesting');
    expect(page).not.toContain('security.bugBountyProgram');
  });
});

describe('the TrustLedger component', () => {
  it('is server-rendered and gives every row a stable anchor', () => {
    expect(component).toContain("from '@/lib/i18n/server'");
    expect(component).not.toContain('useTranslations');
    expect(component).toContain('id={`ledger-${row.key}`}');
  });

  it('renders a pill for each of the four statuses', () => {
    expect(component).toContain('TRUST_LEDGER_STATUSES.map');
    expect(component).toContain('statusLabelKey(status)');
    expect(component).toContain('statusHelpKey(status)');
  });

  it('prints the evidence for a verified row', () => {
    expect(component).toContain("t('trustCenter.evidence')");
    expect(component).toContain('LAST_REVIEWED');
  });
});

// The /ai page is where a visitor is most likely to over-read what Bubaly can
// do, so it carries the same two obligations as the Trust Center: a scripted
// demo is badged as scripted, and the honest statement of what the assistant
// may do alone is one click away rather than restated (and drifting) here.
describe('the /ai page', () => {
  const aiPage = read('app/(marketing)/ai/page.tsx');
  const showcase = read('components/marketing/ai-showcase.tsx');

  it('badges the scripted demo as a sample, beside the prompt list', () => {
    expect(showcase).toContain('SampleBadge');
    expect(showcase).toContain("tr('handledProof.sampleBadge')");
    expect(showcase).toContain("tr('aiShowcase.tryAsking')");
    expect(en['handledProof.sampleBadge']).toBeTruthy();
  });

  it('links the Trust Center instead of restating the trust rules', () => {
    expect(aiPage).toContain('/security#ai-trust');
    expect(aiPage).toContain("t('ai.howBubalyDecides')");
    expect(en['ai.howBubalyDecides']).toBeTruthy();
    expect(en['ai.howBubalyDecidesBody']).toBeTruthy();
  });

  it('no longer claims to be model-agnostic', () => {
    expect(aiPage).not.toMatch(/model-agnostic/i);
    expect(en['ai.descriptionOutcomes']).toBeTruthy();
    expect(en['ai.descriptionOutcomes']).not.toMatch(/model-agnostic/i);
  });
});
