import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateAction, type Policy } from '@/lib/trust/engine';
import { householdPolicyBlocked, localizedTrustReason } from '@/lib/trust/messages';
import { getMessages, translate } from '@/lib/i18n/messages';

// I18N-002. Thirteen money actions (wallet, money, invest) answered a denial
// with `Blocked by household policy: ${decision.reason}` — an English template
// around the engine's English reason, so a German parent read English at the
// moment the household's own rules stopped them. The deny paths now carry a
// catalogue key and CODE-valued params, and the actions render them through
// householdPolicyBlocked in the viewer's language, labels included.

const t = (locale: string) => (key: string, params?: Record<string, string | number>) =>
  translate(getMessages(locale as never), key, params);

const policy = (p: Partial<Policy>): Policy => ({
  id: 'pol', domain: 'all', capability: 'all', subjectKind: 'everyone', effect: 'require_approval',
  conditions: {}, approvalModel: 'single', requiredApprovals: 1, priority: 100, enabled: true, ...p,
});

describe('the engine keys every deny a member can hit', () => {
  it('an explicit per-member block', () => {
    const d = evaluateAction({
      actor: { kind: 'member', id: 'm1', role: 'parent' }, domain: 'finances', capability: 'automate',
      grants: [{ memberId: 'm1', domain: 'finances', capability: 'automate', effect: 'deny' }],
    });
    expect(d).toMatchObject({ effect: 'deny', reasonKey: 'trust.denyExplicitlyBlocked', reasonParams: { domain: 'finances', capability: 'automate' } });
  });

  it('a household policy', () => {
    const d = evaluateAction({
      actor: { kind: 'member', id: 'm1', role: 'adult' }, domain: 'home_maintenance', capability: 'edit',
      policies: [policy({ domain: 'home_maintenance', capability: 'edit', effect: 'deny' })],
    });
    expect(d).toMatchObject({ effect: 'deny', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'home_maintenance' } });
  });

  it('the least-privilege fallback', () => {
    const d = evaluateAction({ actor: { kind: 'member', id: 'k1', role: 'child' }, domain: 'banking', capability: 'delete' });
    expect(d).toMatchObject({ effect: 'deny', reasonKey: 'trust.denyRoleLacksPermission', reasonParams: { role: 'child', capability: 'delete', domain: 'banking' } });
    // The English audit text is unchanged.
    expect(d.reason).toMatch(/permission for Banking/);
  });
});

describe('householdPolicyBlocked speaks the viewer\'s language, labels and all', () => {
  const blocked = evaluateAction({
    actor: { kind: 'member', id: 'm1', role: 'parent' }, domain: 'finances', capability: 'automate',
    grants: [{ memberId: 'm1', domain: 'finances', capability: 'automate', effect: 'deny' }],
  });

  it('in German, with German labels rather than English ones inside a German sentence', () => {
    const message = householdPolicyBlocked(t('de-DE'), blocked);
    expect(message.startsWith('Durch eine Haushaltsrichtlinie blockiert:')).toBe(true);
    expect(message).toContain(translate(getMessages('de-DE'), 'trustDomain.finances'));
    expect(message).toContain(translate(getMessages('de-DE'), 'trustCapability.automate'));
    expect(message).not.toMatch(/Finances|Automate|Blocked/);
  });

  it('in English, with the role, capability and domain from the catalogue', () => {
    // A teen lacks `delete` (ROLE_DEFAULTS), so this is the least-privilege
    // fallback. (Adults hold every capability and never reach it.)
    const d = evaluateAction({ actor: { kind: 'member', id: 't1', role: 'teen' }, domain: 'calendar', capability: 'delete' });
    expect(d.basis).toBe('fallback');
    const en = (key: string) => translate(getMessages('en-US'), key);
    expect(householdPolicyBlocked(t('en-US'), d)).toBe(
      `Blocked by household policy: The ${en('trustRole.teen')} role doesn’t have ${en('trustCapability.delete')} permission for ${en('trustDomain.calendar')}. Ask a parent to grant it.`,
    );
    expect(d.reason, 'the audit text keeps the engine\'s English').toBe('A teen doesn\'t have Delete permission for Calendar. Ask a parent to grant it.');
  });

  it('every locale fills every placeholder', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      for (const d of [blocked, evaluateAction({ actor: { kind: 'member', id: 'k', role: 'teen' }, domain: 'all', capability: 'export' })]) {
        expect(householdPolicyBlocked(t(locale), d), locale).not.toMatch(/\{\w+\}|trustDomain\.|trustCapability\.|trustRole\./);
      }
    }
  });

  it('uses the code for a domain the catalogue does not know, as the engine does', () => {
    expect(localizedTrustReason(t('fr-FR'), { reason: 'x', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'garden_shed' } }))
      .toBe('Bloqué par une règle : garden_shed.');
  });

  it('falls back to the English reason for a decision without a key', () => {
    expect(localizedTrustReason(t('de-DE'), { reason: 'Within a parent’s default permissions.' })).toBe('Within a parent’s default permissions.');
  });
});

describe('the English audit text uses the right article', () => {
  it('says "an adult", not "a adult"', () => {
    const sensitive = evaluateAction({ actor: { kind: 'member', id: 'a1', role: 'adult' }, domain: 'banking', capability: 'delete' });
    expect(sensitive.reason).toBe('Banking is a sensitive area for an adult; a parent should approve.');
    const allowed = evaluateAction({ actor: { kind: 'member', id: 'a1', role: 'adult' }, domain: 'calendar', capability: 'edit' });
    expect(allowed.reason).toBe('Within an adult\'s default permissions.');
    const teen = evaluateAction({ actor: { kind: 'member', id: 't1', role: 'teen' }, domain: 'calendar', capability: 'edit' });
    expect(teen.reason).toBe('Within a teen\'s default permissions.');
  });
});

describe('no money action rebuilds the English template', () => {
  it.each(['app/(app)/wallet/actions.ts', 'app/(app)/money/actions.ts', 'app/(app)/wallet/invest/actions.ts'])('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toContain('Blocked by household policy: ${');
    expect(src).toContain('householdPolicyBlocked(t, decision)');
  });
});
