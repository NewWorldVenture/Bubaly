import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectSays, expectTranslates } from './helpers/translated';
import {
  SHARING_PRESETS, SHARING_SCOPE, delegationFromPreset, findSharingPreset,
  presetTouchesHighStakes, summarizeMemberAccess,
} from '@/lib/trust/sharing-presets';
import { HIGH_STAKES_AI_DOMAINS, ROLE_DEFAULTS, TRUST_DOMAINS } from '@/lib/trust/engine';

const actions = readFileSync('app/(app)/dashboard/trust/actions.ts', 'utf8');
const section = readFileSync('components/modules/trust-sharing-section.tsx', 'utf8');
const trustModule = readFileSync('components/modules/trust-module.tsx', 'utf8');

const NOW = new Date('2026-09-07T18:00:00.000Z');

describe('sharing presets → delegation payload', () => {
  it('maps a preset onto exactly the fields the delegation action takes', () => {
    const preset = findSharingPreset('babysitter_tonight');
    expect(preset).not.toBeNull();

    const delegation = delegationFromPreset(preset!, {
      fromMemberId: 'member-parent', toMemberId: 'member-sitter', now: NOW,
    });

    expect(delegation).toEqual({
      fromMemberId: 'member-parent',
      toMemberId: 'member-sitter',
      domains: ['calendar', 'chores', 'meal_planning'],
      reason: 'Babysitting tonight',
      // 12 hours after `now`, to the millisecond — a delegation that does not
      // expire is a role change wearing a preset's name.
      expiresAt: '2026-09-08T06:00:00.000Z',
    });
  });

  it('lets the caller supply the translated reason that gets persisted', () => {
    const preset = findSharingPreset('grandparent_this_week')!;
    const delegation = delegationFromPreset(preset, {
      fromMemberId: 'a', toMemberId: 'b', now: NOW, reason: 'Hilft diese Woche aus',
    });
    expect(delegation.reason).toBe('Hilft diese Woche aus');
    expect(delegation.expiresAt).toBe('2026-09-14T18:00:00.000Z');
  });

  it('gives every preset a future expiry no further out than a week', () => {
    for (const preset of SHARING_PRESETS) {
      const { expiresAt } = delegationFromPreset(preset, { fromMemberId: 'a', toMemberId: 'b', now: NOW });
      const ms = new Date(expiresAt).getTime() - NOW.getTime();
      expect(ms, preset.key).toBeGreaterThan(0);
      expect(ms, preset.key).toBeLessThanOrEqual(7 * 24 * 3_600_000);
    }
  });

  it('never hands a high-stakes domain over in one tap', () => {
    for (const preset of SHARING_PRESETS) {
      expect(presetTouchesHighStakes(preset), `${preset.key} names a high-stakes domain`).toBe(false);
      for (const domain of preset.domains) {
        expect(TRUST_DOMAINS as readonly string[]).toContain(domain);
        expect(HIGH_STAKES_AI_DOMAINS).not.toContain(domain);
      }
    }
  });

  it('answers null for a preset key it does not know', () => {
    expect(findSharingPreset('everything_forever')).toBeNull();
  });
});

describe('the preset action writes through the existing delegation action', () => {
  // The scope must be decided on the SERVER. A client that could post domains
  // and an expiry would turn "Babysitter tonight" into whatever it liked.
  it('takes only a preset key and two members from the client', () => {
    expect(actions).toContain('export async function createSharingPresetAction(input: {');
    expect(actions).toContain('presetKey: string; fromMemberId: string; toMemberId: string;');
    expect(actions).toContain('const preset = findSharingPreset(input.presetKey);');
    expect(actions).toContain('const delegation = delegationFromPreset(preset, {');
    expect(actions).toContain('return createDelegationAction(delegation);');
    expectTranslates(actions, 'actions.unknownSharingPreset', 'Unknown sharing preset.');
  });

  it('is what the panel calls, with the key alone', () => {
    expect(section).toContain("import { createSharingPresetAction } from '@/app/(app)/dashboard/trust/actions';");
    expect(section).toContain('await createSharingPresetAction({ presetKey: preset.key, fromMemberId, toMemberId: toMember })');
    // No inert button: the preset tile opens the chooser, the chooser writes.
    expect(section).not.toMatch(/onClick=\{\(\) => \{\}\}/);
  });

  it('is mounted on the Trust page', () => {
    expect(trustModule).toContain("import { TrustSharingSection } from '@/components/modules/trust-sharing-section';");
    expect(trustModule).toContain('<TrustSharingSection members={data.members} grants={data.grants} delegations={data.delegations} canManage={canManage} />');
  });
});

describe('per-member access summary', () => {
  const base = {
    memberId: 'sitter', role: 'caregiver' as const, grants: [], delegations: [], now: NOW,
  };

  it('reports the role defaults the trust engine actually applies', () => {
    const summary = summarizeMemberAccess(base);
    expect(summary.capabilities).toEqual(ROLE_DEFAULTS.caregiver.capabilities);
    expect(summary.approvalDomains).toEqual(ROLE_DEFAULTS.caregiver.sensitiveDomains);
    expect(summary.automationTrusted).toBe(false);
  });

  it('separates deny grants from allow grants and ignores other members rows', () => {
    const summary = summarizeMemberAccess({
      ...base,
      grants: [
        { member_id: 'sitter', domain: 'finances', capability: 'view', effect: 'deny' },
        { member_id: 'sitter', domain: 'calendar', capability: 'edit', effect: 'allow' },
        { member_id: 'someone-else', domain: 'banking', capability: 'edit', effect: 'allow' },
        { member_id: 'sitter', domain: 'not_a_domain', capability: 'edit', effect: 'allow' },
      ],
    });
    expect(summary.denied).toEqual([{ domain: 'finances', capability: 'view' }]);
    expect(summary.allowed).toEqual([{ domain: 'calendar', capability: 'edit' }]);
  });

  it('counts only live delegations — an expired or revoked one is not authority', () => {
    const summary = summarizeMemberAccess({
      ...base,
      delegations: [
        { to_member_id: 'sitter', domains: ['calendar', 'chores'], expires_at: '2026-09-08T06:00:00.000Z' },
        { to_member_id: 'sitter', domains: ['transportation'], expires_at: '2026-09-10T06:00:00.000Z' },
        { to_member_id: 'sitter', domains: ['finances'], expires_at: '2026-09-01T06:00:00.000Z' },
        { to_member_id: 'sitter', domains: ['banking'], expires_at: '2026-09-20T06:00:00.000Z', revoked_at: '2026-09-05T00:00:00.000Z' },
        { to_member_id: 'other', domains: ['documents'], expires_at: '2026-09-20T06:00:00.000Z' },
      ],
    });
    expect(summary.delegatedDomains).toEqual(['calendar', 'chores', 'transportation']);
    // The soonest expiry is the one the panel must show — it is when the first
    // of these lapses.
    expect(summary.delegationExpiresAt).toBe('2026-09-08T06:00:00.000Z');
  });

  it('reports no delegation rather than a null expiry with domains', () => {
    const summary = summarizeMemberAccess(base);
    expect(summary.delegatedDomains).toEqual([]);
    expect(summary.delegationExpiresAt).toBeNull();
  });

  it('falls back to the least-privileged role for an unknown one', () => {
    const summary = summarizeMemberAccess({ ...base, role: 'houseplant' });
    expect(summary.role).toBe('guest');
    expect(summary.capabilities).toEqual(ROLE_DEFAULTS.guest.capabilities);
  });
});

describe('the panel does not claim a scope the database does not enforce', () => {
  // RLS is role-based (is_family_member vs can_manage_family): a delegation
  // gates ACTIONS through evaluateTrust and does not narrow anyone's reads.
  // Saying otherwise on this panel would be the exact overclaim M23 is about.
  it('declares that delegations govern actions, not reads', () => {
    expect(SHARING_SCOPE.governsActions).toBe(true);
    expect(SHARING_SCOPE.scopesReads).toBe(false);
  });

  it('says so on the panel, in the reader is own language', () => {
    expectSays(
      section,
      'trustSharing.actionsNotReadsNote',
      "These rules govern actions — what a person, and Bubaly acting for them, may do. They do not narrow what the family's shared pages show: per-person limits on what is visible need a database change that has not shipped yet.",
    );
  });

  it('labels the summary rows as what a person can DO', () => {
    expectSays(section, 'trustSharing.whatEachPersonCanDo', 'What each person can do');
    expectSays(section, 'trustSharing.canDo', 'Can do');
    // Nothing anywhere in the section promises that a person only SEES a subset.
    expect(section).not.toMatch(/can only see/i);
  });
});
