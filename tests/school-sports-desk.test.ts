// The School & Sports desk: the wiring, the fences and the claims.
//
// The classifier itself is pinned in tests/school-sports-classifier.test.ts.
// This file is about everything AROUND it — what the router now files, what the
// desk card is allowed to say, what the server action is allowed to do, and the
// exact schema boundary the no-migration slice stops at. Several assertions are
// made against the source text rather than by rendering: the desk card is a
// client component behind an app context and a Supabase client, and the
// properties worth defending here (a failed read is not an empty desk; nothing
// is marked handled before it happened) are structural, not visual.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  autoReplyText, classifyIntent, intentMeta, routeInbound, shouldNotifyFamily, shouldPlanInbound,
} from '@/lib/contact-center/routing';
import { buildProposal, classify } from '@/lib/front-desk/school-sports';

const deskCard = readFileSync('components/modules/school-module.tsx', 'utf8');
const deskAction = readFileSync('app/(app)/dashboard/school/actions.ts', 'utf8');
const importRoute = readFileSync('app/api/ai/import/route.ts', 'utf8');
const contactCenterMigration = readFileSync('supabase/migrations/0214_family_contact_center.sql', 'utf8');
const schoolService = readFileSync('lib/services/school/index.ts', 'utf8');

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const catalogues = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(`lib/i18n/messages/${l}.json`, 'utf8')) as Record<string, string>]),
);

/** The columns 0214 actually gives `family_inbox_messages`. */
function inboxColumns(): string[] {
  const table = /create table if not exists public\.family_inbox_messages \(([\s\S]*?)\n\);/i.exec(contactCenterMigration);
  expect(table).not.toBeNull();
  return table![1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => /^[a-z_]+$/.test(name));
}

describe('inbound routing knows school and sports', () => {
  it('files a school notice as school', () => {
    expect(classifyIntent('Please sign and return the permission slip for the school field trip.')).toBe('school');
    expect(classifyIntent('Parent-teacher evening bookings open Monday.')).toBe('school');
  });

  it('files a club message as sports', () => {
    expect(classifyIntent('Soccer practice has moved to 6pm; the coach will confirm.')).toBe('sports');
  });

  it('does not disturb the intents that were there before', () => {
    expect(classifyIntent('This is an emergency, call me ASAP')).toBe('urgent');
    expect(classifyIntent('Can we reschedule the dentist appointment?')).toBe('appointment');
    expect(classifyIntent('Your package is out for delivery')).toBe('delivery');
    expect(classifyIntent('Limited time offer — save $50 on your warranty')).toBe('sales');
    expect(classifyIntent('You have won a gift card, click this link')).toBe('spam');
    expect(classifyIntent('Hey, are we still on for dinner Saturday?')).toBe('personal');
    expect(classifyIntent('')).toBe('other');
  });

  it('lets urgent outrank the desk, because a hurt child is not a queue item', () => {
    expect(classifyIntent('Emergency: your son was hurt at soccer practice, please come to the school.')).toBe('urgent');
    expect(shouldNotifyFamily('urgent')).toBe(true);
  });

  it('routes school and sports like the rest of the household mail', () => {
    expect(routeInbound('school')).toBe('auto_reply');
    expect(routeInbound('sports')).toBe('auto_reply');
    expect(shouldNotifyFamily('school')).toBe(false);
    expect(shouldNotifyFamily('sports')).toBe(false);
  });

  it('sends them to the planner, which is gated, rather than executing anything', () => {
    expect(shouldPlanInbound('school')).toBe(true);
    expect(shouldPlanInbound('sports')).toBe(true);
    expect(shouldPlanInbound('sales')).toBe(false);
    expect(shouldPlanInbound('spam')).toBe(false);
    expect(shouldPlanInbound('urgent')).toBe(false);
  });

  it('gives the inbox a label for each', () => {
    expect(intentMeta('school').label).toBe('School');
    expect(intentMeta('sports').label).toBe('Sports');
    expect(intentMeta('nonsense').label).toBe('General');
  });

  it('auto-replies without claiming a link no column could hold', () => {
    // These replies are really sent: app/api/contact-center/sms/route.ts falls
    // back to autoReplyText whenever the provider returns none, persists it via
    // recordOutboundMessage and hands it back as TwiML. So they may claim only
    // what filing the message proves. Nothing ties a message to a child, a team
    // or a schedule — 0214 has no member_id, linked_type, linked_id or
    // sub_intent — and the sports line used to say it had "flagged it with
    // their team schedule".
    for (const intent of ['school', 'sports'] as const) {
      const reply = autoReplyText(intent, 'the Smiths');
      expect(reply).toContain('the Smiths');
      expect(reply).toMatch(/logged/i);
      expect(reply).not.toMatch(/team schedule|their calendar|linked|added it to|booked|signed/i);
    }
  });

  it('stores the verdict in a free-text column — 0214 puts no CHECK on ai_intent', () => {
    const line = /^\s*ai_intent\s+text.*$/m.exec(contactCenterMigration);
    expect(line).not.toBeNull();
    expect(line![0].toLowerCase()).not.toContain('check');
  });
});

describe('the no-migration boundary', () => {
  it('is exactly the columns 0214 gives the table', () => {
    expect(inboxColumns().sort()).toEqual([
      'ai_handled', 'ai_intent', 'ai_summary', 'body', 'channel', 'created_at',
      'direction', 'family_id', 'from_addr', 'id', 'occurred_at', 'provider_ref',
      'status', 'subject', 'to_addr',
    ]);
  });

  it('has no member_id, linked_* or sub_intent — so nothing may read or write one', () => {
    const columns = inboxColumns();
    for (const absent of ['member_id', 'linked_type', 'linked_id', 'sub_intent', 'metadata']) {
      expect(columns).not.toContain(absent);
    }
    // Named as a column — quoted, or as an object key — rather than merely
    // mentioned: the files talk about these columns at length precisely
    // because they do not exist.
    for (const source of [deskCard, deskAction, importRoute]) {
      expect(source).not.toMatch(/['"]sub_intent['"]|\bsub_intent\s*[:=]/);
      expect(source).not.toMatch(/['"]linked_(?:type|id)['"]|\blinked_(?:type|id)\s*[:=]/);
    }
  });

  it('reads only columns that exist', () => {
    const select = /from\('family_inbox_messages'\)\s*\n?\s*\.select\('([^']+)'\)/.exec(deskCard);
    expect(select).not.toBeNull();
    const requested = select![1].split(',').map((c) => c.trim());
    const columns = inboxColumns();
    for (const column of requested) expect(columns).toContain(column);
  });
});

describe('the desk card fails closed', () => {
  it('logs the real error under its own namespace', () => {
    expect(deskCard).toContain("console.error('[school-desk] front desk read failed'");
  });

  it('renders an error with a retry, never an empty desk', () => {
    expect(deskCard).toContain("<ErrorState message={tr('schoolDesk.readFailed')} onRetry=");
    // The error branch is tested BEFORE the empty branch, so a failed read can
    // never fall through to "nothing waiting from school".
    const errorAt = deskCard.indexOf('deskError ? (');
    const emptyAt = deskCard.indexOf('deskItems.length === 0 ? (');
    expect(errorAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(errorAt);
    // And a failed read leaves the rows null rather than an empty array.
    expect(deskCard).toContain('setDeskRows(null);');
    expect(deskCard).toContain('if (!deskRows) return [];');
  });

  it('batches its two reads through settleAll, with no ServiceResult riding along', () => {
    expect(deskCard).toContain('await settleAll([');
    const batch = /await settleAll\(\[([\s\S]*?)\]\);/.exec(deskCard);
    expect(batch).not.toBeNull();
    // Only PostgREST builders in the array — a ServiceResult has `ok`, not
    // `data`, and could never be unwrapped by settleAll's fallback shape.
    expect(batch![1]).not.toMatch(/countOrNull|ServiceResult|\bok:\s/);
    expect((batch![1].match(/sb\.from\(/g) ?? []).length).toBe(2);
  });
});

describe('the desk card only claims what a row says', () => {
  it('reads Handled off ai_handled and nowhere else', () => {
    expect(deskCard).toContain("{row.ai_handled ? (");
    expect(deskCard).toContain("{tr('schoolDesk.handled')}");
    // Exactly one place puts that word on screen, and it is inside the
    // ai_handled branch.
    const handledUses = deskCard.match(/schoolDesk\.handled/g) ?? [];
    expect(handledUses.length).toBe(1);
    const branchAt = deskCard.indexOf('{row.ai_handled ? (');
    const wordAt = deskCard.indexOf("tr('schoolDesk.handled')");
    expect(wordAt).toBeGreaterThan(branchAt);
  });

  it('never writes to the inbox from the browser — 0214 grants members SELECT only', () => {
    const clientWrite = /from\('family_inbox_messages'\)[\s\S]{0,200}?\.(update|insert|upsert|delete)\(/.exec(deskCard);
    expect(clientWrite).toBeNull();
  });

  it('re-reads after a proposal instead of assuming what the write did', () => {
    expect(deskCard).toContain('await loadDesk();');
  });

  it('says "marked handled" only when the write came back saying so', () => {
    // `proposeFrontDeskAction` returns `handled` — computed from the row the
    // service-role update returned — precisely so the toast can tell "the
    // action ran AND ai_handled is now true" from "the action ran but the mark
    // failed". The desk used to toast the first for every executed outcome,
    // and the loadDesk() on the very next line then rendered that same row
    // WITHOUT the Handled badge.
    const fn = /async function proposeFromDesk\([\s\S]*?\n  \}/.exec(deskCard);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('} else if (result.handled) {');
    const branchAt = fn![0].indexOf('result.handled');
    const appliedAt = fn![0].indexOf("tr('schoolDesk.proposalApplied')");
    expect(branchAt).toBeGreaterThan(-1);
    expect(appliedAt).toBeGreaterThan(branchAt);
    // The other half of the branch says something the row can stand behind.
    expect(fn![0]).toContain("tr('schoolDesk.proposalNotMarked')");
    // And exactly one place makes the stronger claim.
    expect((deskCard.match(/schoolDesk\.proposalApplied/g) ?? []).length).toBe(1);
  });

  it('never leaves Propose stuck on "Proposing…" when the server action rejects', () => {
    const fn = /async function proposeFromDesk\([\s\S]*?\n  \}/.exec(deskCard);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('.catch(');
    expect(fn![0]).toContain("console.error('[school-desk] propose failed'");
    expect(fn![0]).toContain('setProposing(null);');
    expect(fn![0]).toContain("toastError(tr('schoolDesk.couldNotPropose'))");
  });

  it('classifies at read time, because there is no column to store it in', () => {
    expect(deskCard).toContain('verdict: classify(row, roster, deskTeams, classes, { now })');
  });
});

describe('proposals go through the approval spine', () => {
  it('asks the shared AI gate before anything else', () => {
    expect(deskAction).toContain('await gateAiAction(');
    expect(deskAction).toContain("actorId: 'school_front_desk'");
  });

  it('executes only on allow, through runAction', () => {
    const gateAt = deskAction.indexOf('await gateAiAction(');
    const denyAt = deskAction.indexOf("if (outcome.effect === 'deny')");
    const approvalAt = deskAction.indexOf("if (outcome.effect === 'require_approval')");
    const runAt = deskAction.indexOf('await runAction(');
    expect(gateAt).toBeGreaterThan(-1);
    expect(denyAt).toBeGreaterThan(gateAt);
    expect(approvalAt).toBeGreaterThan(denyAt);
    expect(runAt).toBeGreaterThan(approvalAt);
  });

  it('marks handled only AFTER the action reported success', () => {
    const runFailedAt = deskAction.indexOf('if (!ran.ok) return');
    const markAt = deskAction.indexOf('await markInboxMessageHandled(');
    expect(runFailedAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(runFailedAt);
    // There is exactly one such write, so no branch can sneak a second one in.
    expect((deskAction.match(/markInboxMessageHandled\(/g) ?? []).length).toBe(1);
  });

  it('does not mark a message handled when it is only waiting for a parent', () => {
    const approvalReturn = /if \(outcome\.effect === 'require_approval'\) \{([\s\S]*?)\n  \}/.exec(deskAction);
    expect(approvalReturn).not.toBeNull();
    expect(approvalReturn![1]).not.toContain('markInboxMessageHandled');
    expect(approvalReturn![1]).toContain("outcome: 'pending_approval'");
  });

  it('uses the service role for the one privileged write, and the caller for reads', () => {
    expect(deskAction).toContain('markInboxMessageHandled({ ...scope, db: createServiceClient() }');
    expect(deskAction).toContain('await loadInboxMessage(scope, messageId)');
  });

  it('keeps ServiceResults out of any batch', () => {
    expect(deskAction).not.toMatch(/await settleAll\(/);
    for (const call of ['await getMembers(scope)', 'await listClassRoster(scope)', 'await listTeams(scope,']) {
      expect(deskAction).toContain(call);
    }
  });

  it('refuses a member who may not file family mail', () => {
    expect(deskAction).toContain('if (!isManager(ctx.active.role))');
  });
});

describe('magic import proposes the same thing', () => {
  it('runs the classifier beside the model', () => {
    expect(importRoute).toContain("from '@/lib/front-desk/school-sports'");
    expect(importRoute).toContain('const desk = frontDeskItem(text, now);');
  });

  it('does not double up on a row the model already proposed', () => {
    expect(importRoute).toContain('alreadyProposed');
    expect(importRoute).toContain('desk && !alreadyProposed ? [...items.items, desk] : items.items');
  });

  it('still sends every confirmed item through the gate', () => {
    expect(importRoute).toContain('await gateAiAction(');
    expect(importRoute).toContain("if (outcome.effect === 'require_approval')");
  });

  it('names the gear in the summary a parent is asked to approve', () => {
    // The gear branch emits the registry's BATCH shape, never {name}.
    const message = {
      subject: null,
      body: 'Soccer practice Saturday: please bring cleats, shin guards and a water bottle.',
    };
    const verdict = classify(message, [], [], [], { now: '2026-09-09T12:00:00.000Z' });
    expect(verdict.subKind).toBe('gear');
    const proposal = buildProposal(message, verdict);
    expect(proposal?.name).toBe('add_grocery_item');
    expect(proposal?.args.name).toBeUndefined();
    expect(proposal?.args.items).toEqual([
      { name: 'cleats' }, { name: 'shin guards' }, { name: 'water bottle' },
    ]);

    // So reading `a.name` for that shape prints "Grocery: undefined" — and the
    // summary is both the line in the confirm list AND the `title` phase 2
    // hands gateAiAction, which is persisted as approval_requests.title.
    expect(importRoute).toContain('function groceryNames(');
    const summarizeFn = /function summarize\([\s\S]*?\n}/.exec(importRoute);
    expect(summarizeFn).not.toBeNull();
    expect(summarizeFn![0]).toContain('groceryNames(a)');
    expect(summarizeFn![0]).not.toMatch(/Grocery: \$\{a\.name\}/);
  });

  it('de-duplicates a batched grocery item by the names it would add', () => {
    // itemKey read title/name/meal_name only, all absent from the batch shape,
    // so every gear list keyed as the empty string and looked like a duplicate
    // of every other one.
    const keyFn = /function itemKey\([\s\S]*?\n}/.exec(importRoute);
    expect(keyFn).not.toBeNull();
    expect(keyFn![0]).toContain("item.name === 'add_grocery_item' ? groceryNames(item.args)");
  });

  it('maps every proposable tool to a trust domain', () => {
    for (const tool of ['create_calendar_event', 'create_reminder', 'add_grocery_item']) {
      expect(importRoute).toMatch(new RegExp(`${tool}: '`));
    }
  });
});

describe('the roster read', () => {
  it('is a service read that fails closed', () => {
    expect(schoolService).toContain('export async function listClassRoster(');
    expect(schoolService).toContain("console.error('[service:school] class roster read failed', error);");
    const fn = /export async function listClassRoster\([\s\S]*?\n}/.exec(schoolService);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("return fail(describeDbError(error,");
    // Unfiltered by week parity on purpose: a teacher identifies her pupil in
    // a B week too.
    expect(fn![0]).not.toContain('classOccursInWeek');
    expect(fn![0]).toContain(".eq('family_id', scope.familyId)");
  });
});

describe('every string the desk shows is translated', () => {
  const used = new Set<string>();
  for (const source of [deskCard, deskAction]) {
    for (const match of source.matchAll(/'(schoolDesk\.[A-Za-z]+)'/g)) used.add(match[1]);
  }

  it('finds the keys it is looking for', () => {
    expect(used.size).toBeGreaterThanOrEqual(20);
  });

  for (const locale of LOCALES) {
    it(`has every key in ${locale}`, () => {
      const missing = [...used].filter((key) => !(key in catalogues[locale]));
      expect(missing).toEqual([]);
    });
  }

  it('says something different in each language where it should', () => {
    // The two that are legitimately the same word are named, so a genuinely
    // missed translation cannot hide behind them.
    const invariant = new Set(['schoolDesk.domainSchool', 'schoolDesk.kindTransport', 'schoolDesk.proposalTitle']);
    for (const key of used) {
      if (invariant.has(key)) continue;
      const english = catalogues['en-US'][key];
      for (const locale of LOCALES.filter((l) => l !== 'en-US')) {
        expect(catalogues[locale][key], `${key} [${locale}]`).not.toBe(english);
      }
    }
  });
});

// The gate can decide an action NEEDS approval and then fail to open the row —
// `GateOutcome.approvalId` is `string | null` for exactly that case. A green
// "sent for a parent to approve" then promises a review that is not in anyone's
// queue, which is the one thing this desk must never say.
describe('a proposal held for approval says so only when an approval exists', () => {
  const module = readFileSync(new URL('../components/modules/school-module.tsx', import.meta.url), 'utf8');
  const branch = module.slice(module.indexOf("if (result.outcome === 'pending_approval')"), module.indexOf("} else if (result.handled)"));

  it('reads approvalId before claiming a parent was asked', () => {
    expect(branch).toContain('result.approvalId');
    expect(branch).toContain("success(tr('schoolDesk.sentForApproval'))");
    // The success toast is guarded, never unconditional.
    expect(branch).not.toMatch(/^\s*success\(tr\('schoolDesk\.sentForApproval'\)\);\s*$/m);
  });

  it('says nothing ran and nothing is queued when the approval was not recorded', () => {
    expect(branch).toContain("toastError(tr('schoolDesk.approvalNotRecorded'))");
    const en = JSON.parse(readFileSync(new URL('../lib/i18n/messages/en-US.json', import.meta.url), 'utf8')) as Record<string, string>;
    const copy = en['schoolDesk.approvalNotRecorded'];
    expect(copy).toBeTruthy();
    expect(copy).toMatch(/nothing ran/i);
    // It must not imply a parent will see it.
    expect(copy).not.toMatch(/sent (for|to)/i);
  });

  it('carries that copy in every locale', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const cat = JSON.parse(readFileSync(new URL(`../lib/i18n/messages/${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>;
      expect(cat['schoolDesk.approvalNotRecorded'], locale).toBeTruthy();
    }
  });
});
