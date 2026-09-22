import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// F-F07 counted 37 of 51 money-area server actions with no test. Coverage is
// the symptom; the property worth holding is narrower and checkable: an action
// that writes a row ABOUT a family member must say which member, and agree with
// who is calling.
//
// `isManager(ctx.active.role)` is how most of them do it. The ones that must
// not — a child submitting proof of their own chore, asking for their allowance,
// requesting a redemption — are the product, and they need the other half:
// scoped to the caller's own member, not merely to their family.
//
// Two of them had neither. `submitProofAction` and `disputeSubmissionAction`
// loaded their row filtered on `family_id` only and then attributed the write
// to the ASSIGNEE, so a sibling could submit a photo against another child's
// chore, or open a dispute the record said that child had raised. Fixed in the
// actions and in `0327`; `docs/audit/chore-proof-ownership-check.sql` proves the
// database half, and this file holds the app half.
const AREAS = ['wallet', 'kids', 'economy', 'missions', 'money'];
const MANAGER_GATE = /\bisManager\s*\(|\bisFamilyAdmin\s*\(|requireManager\s*\(|assertManager\s*\(/;
/** Reads the CALLER's own member, rather than only their family. */
const SELF_SCOPED = /ctx\.active\.member\.id|is_self_member|isSelfMember/;

/**
 * Actions that deliberately answer to a member rather than a manager, each with
 * the reason. A member-scoped action is not a gap — it is the child's half of
 * the product — but it has to be a decision somebody wrote down, because the
 * alternative reads identically to having forgotten.
 */
const MEMBER_SCOPED: Record<string, string> = {
  requestAllowanceAction: 'a child asks for their allowance; the request is not the payment',
  requestRedemptionAction: 'a child asks to spend their own tokens; a manager decides',
  placeInvestOrderAction: 'a child places an order that a parent approves (DB-FN-002)',
  submitProofAction: 'a child submits proof of their OWN chore — assignee or manager, checked since F-F07',
  disputeSubmissionAction: 'a child disputes their OWN submission — assignee or manager, checked since F-F07',
};

/**
 * Actions that write a row about the FAMILY rather than about a member, so
 * "whose row is it" has no answer to check. Listed so the set stays reviewed.
 */
const FAMILY_SCOPED: Record<string, string> = {
  setMoneyInsightStatusAction: 'dismisses a family-wide money insight; nothing is attributed to a member',
  syncMoneyInsightsAction: 'recomputes the family timeline from family rows',
  addCardAction: 'adds a card to the family wallet hub',
  addPassAction: 'adds a pass to the family wallet hub',
  addRewardAction: 'adds a reward to the family wallet hub',
  generatePlanAction: 'drafts a chore plan for the family; a manager still assigns it',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const blankComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/** Exported action names in one file, with the body that follows each. */
function actionBodies(source: string): Map<string, string> {
  const src = blankComments(source);
  const decls = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)];
  const bodies = new Map<string, string>();
  decls.forEach((m, i) => {
    const end = i + 1 < decls.length ? decls[i + 1].index! : src.length;
    bodies.set(m[1], src.slice(m.index!, end));
  });
  return bodies;
}

describe('a money-area action says whose row it is', () => {
  const files = walk('app').filter((f) => f.includes('actions') && AREAS.some((a) => f.includes(a)));
  const actions: { file: string; name: string; body: string }[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const bodies = actionBodies(source);
    for (const m of blankComments(source).matchAll(/^export async function (\w+)/gm)) {
      actions.push({ file, name: m[1], body: bodies.get(m[1]) ?? '' });
    }
  }

  it('finds the action surface (non-vacuity)', () => {
    expect(files.length).toBeGreaterThan(4);
    expect(actions.length).toBeGreaterThan(40);
  });

  it('every action is manager-gated, member-scoped, or declared family-wide', () => {
    const unaccounted = actions
      .filter((a) => !MANAGER_GATE.test(a.body))
      .filter((a) => !(a.name in MEMBER_SCOPED) && !(a.name in FAMILY_SCOPED))
      .map((a) => `${a.file} :: ${a.name}`);
    expect(
      unaccounted,
      'These write in the money area without a manager check. If the action is a member\'s own\n'
      + '(a child asking for something), add it to MEMBER_SCOPED with the reason and scope it to\n'
      + 'ctx.active.member.id. If it writes about the family, add it to FAMILY_SCOPED:\n'
      + unaccounted.join('\n'),
    ).toEqual([]);
  });

  it('every declared member-scoped action actually reads the caller\'s member', () => {
    // The half that makes the declaration worth anything. A name on the list
    // and a body that only filters on `family_id` is the gap F-F07 exposed,
    // wearing a licence.
    const unscoped = actions
      .filter((a) => a.name in MEMBER_SCOPED && !MANAGER_GATE.test(a.body))
      .filter((a) => !SELF_SCOPED.test(a.body))
      .map((a) => `${a.file} :: ${a.name}`);
    expect(
      unscoped,
      'declared member-scoped and never reads ctx.active.member.id — same family is not same person:\n'
      + unscoped.join('\n'),
    ).toEqual([]);
  });

  it('neither declaration lies', () => {
    const names = new Set(actions.map((a) => a.name));
    const stale = [...Object.keys(MEMBER_SCOPED), ...Object.keys(FAMILY_SCOPED)].filter((n) => !names.has(n));
    expect(stale, 'declared but no longer an exported action here — delete the line:\n' + stale.join('\n')).toEqual([]);
  });

  it('the two chore actions check the assignee, and log the real actor', () => {
    const src = blankComments(readFileSync('app/(app)/missions/actions.ts', 'utf8'));
    // Assignee or manager, on both.
    expect(src).toMatch(/assignment\.member_id === ctx\.active\.member\.id/);
    expect(src).toMatch(/submission\.member_id !== ctx\.active\.member\.id && !isManager\(ctx\.active\.role\)/);
    // And the dispute's event names who disputed, not whose chore it is.
    expect(src).toMatch(/actorId: ctx\.active\.member\.id, action: 'dispute'/);
    expect(src).not.toMatch(/actorId: submission\.member_id, action: 'dispute'/);
  });
});
