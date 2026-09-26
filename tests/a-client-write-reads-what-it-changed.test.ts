import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between, bodyOf } from './helpers/source-order';

/**
 * Audit C1-S9-77 — client modules that report a write they cannot see.
 *
 * Under RLS a refused row is refused with NO error: zero rows come back, and
 * each of these modules said "Member removed", "Record updated", "Deleted".
 * The components ratchet (an-unconfirmed-write-in-components-ratchet) holds
 * that the writes now ASK for their rows; this holds that the answer is READ —
 * a `.select('id')` whose result nobody checks is the same lie with one more
 * round trip.
 */
const FIXED = [
  'components/modules/family-module.tsx',
  'components/modules/health-module.tsx',
  'components/modules/health-visits-module.tsx',
  'components/modules/immunizations-module.tsx',
  'components/modules/care-module.tsx',
  'components/modules/devices-module.tsx',
  'components/modules/reminders-module.tsx',
  'components/modules/concierge-module.tsx',
  'components/modules/projects-module.tsx',
  'components/modules/career-module.tsx',
  'components/modules/declutter-module.tsx',
  'components/modules/moving-module.tsx',
  'components/modules/inventory-module.tsx',
  'components/modules/language-module.tsx',
  'components/modules/watchlist-module.tsx',
  'components/modules/closet-module.tsx',
  'components/modules/relationship-module.tsx',
  'components/modules/messages-module.tsx',
  'components/modules/recipes-module.tsx',
  'components/modules/subscriptions-module.tsx',
  'components/modules/voting-module.tsx',
  'components/modules/weekend-module.tsx',
  'components/modules/wishlists-module.tsx',
  'components/modules/sleep-module.tsx',
  'components/modules/photos-module.tsx',
  'components/modules/notifications-module.tsx',
  'components/modules/inbox-module.tsx',
  'components/modules/homework-module.tsx',
  'components/modules/home-module.tsx',
  'components/modules/expenses-module.tsx',
  'components/modules/routines-panel.tsx',
  'components/modules/settings-module.tsx',
  'components/modules/weather-module.tsx',
  'components/modules/decisions-module.tsx',
  'components/modules/shopping-module.tsx',
  'components/modules/connections-module.tsx',
  'components/memories/create-memory.tsx',
  'components/modules/chores-module.tsx',
  'components/modules/meals-module.tsx',
  'components/vacations/shared.tsx',
  'components/vacations/trip-itinerary.tsx',
  'components/vacations/trip-packing.tsx',
  'components/vacations/trip-budget.tsx',
  'components/vacations/trip-overview.tsx',
  'components/family/play-dates-view.tsx',
  'components/family/check-in-view.tsx',
  'components/family/driving-safety-view.tsx',
  'components/meals/favorites-view.tsx',
  'components/meals/nutrition-view.tsx',
  'components/marketplace/listing-questions.tsx',
  'components/modules/contacts-module.tsx',
  'components/modules/journal-module.tsx',
  'components/modules/marketplace-module.tsx',
  'components/modules/pets-module.tsx',
  'components/modules/planning-module.tsx',
  'components/modules/reminders-module.tsx',
  'components/modules/family-tree-module.tsx',
  'components/modules/behavior-module.tsx',
  'components/modules/binder-module.tsx',
  'components/modules/announcements-module.tsx',
  'components/modules/assistant-module.tsx',
  'components/modules/celebrations-module.tsx',
  'components/modules/concierge-module.tsx',
  'components/modules/insurance-module.tsx',
  'components/modules/life-events-module.tsx',
  'components/modules/screen-time-module.tsx',
  'components/modules/security-module.tsx',
  'components/modules/tax-vault-module.tsx',
  'components/modules/timetable-module.tsx',
  'components/modules/trip-memories-module.tsx',
  'components/modules/utilities-module.tsx',
  'components/modules/voice-module.tsx',
];

describe('a confirmed client write is read, not just requested (C1-S9-77)', () => {
  it.each(FIXED)('%s checks every row set it asks for', (file) => {
    const src = readFileSync(file, 'utf8');
    // `let` too: a save that retries reassigns its result. 1,200, not 400: a
    // long update payload put `.select('id')` beyond 400 characters (family
    // tree), and the binding went unseen — a mutation survived on exactly that
    // (C1-S9-85). `[^;]`, not `[\s\S]`: the `.select('id')` must be in the
    // binding's OWN statement, or a storage upload's `data: stored` borrows the
    // next statement's select and is reported as an unread write.
    const bindings = [...src.matchAll(/(?:const|let) \{ data: (\w+), error(?:: \w+)? \} = [^;]{0,1200}?\.select\('id'\)/g)].map((m) => m[1]);
    expect(bindings.length, 'no confirmed write found — the file changed shape').toBeGreaterThan(0);
    for (const b of bindings) {
      // Read as "none", against an exact expected count, or — for a
      // `.single()` result — as absence (`|| !created`); or, for a batch,
      // row by row (`(deleted ?? []).map`, C1-S9-83).
      const read = [`wroteNoRows(${b})`, `(${b}?.length ?? 0) !==`, `|| !${b})`, `if (!${b})`, `if (!${b}?.length)`, `(${b} ?? []).map(`].find((r) => src.includes(r)) ?? `wroteNoRows(${b})`;
      expect(src, `${b} is requested but never read`).toContain(read);
      // …and read AFTER it is bound, not in some earlier function.
      expect(at(src, `data: ${b}, error`)).toBeLessThan(at(src, read));
    }
  });

  it('a zero-row write says it was not saved, in the family\'s language', () => {
    const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    expect(en['errors.thatChangeWasNotSaved']).toBe("That change wasn't saved — you may not have permission. Refresh and try again.");
    // The assistant says it with its own translated conversation errors
    // (`assistantModule.couldNotDeleteThatConversation`, C1-S9-86).
    for (const file of FIXED.filter((f) => !f.endsWith('health-module.tsx') && !f.endsWith('assistant-module.tsx'))) {
      expect(readFileSync(file, 'utf8'), file).toMatch(/\(['"]errors\.thatChangeWasNotSaved['"]\)/);
    }
  });
});

describe('a plan acceptance that never landed does not run the loop (C1-S9-77)', () => {
  it('the status move is confirmed and reverted on screen before planAcceptedAction can run', () => {
    const src = readFileSync('components/modules/concierge-module.tsx', 'utf8');
    const fn = between(src, 'async function updateStatus(status: string) {', 'planAcceptedAction(plan.id, prev, status)');
    expect(fn).toContain("if (wroteNoRows(moved)) { setEditStatus(prev); toastError(t('errors.thatChangeWasNotSaved')); return; }");
  });

  it('the server acts on the persisted status, not the caller\'s claim', () => {
    const src = readFileSync('app/(app)/dashboard/concierge/actions.ts', 'utf8');
    const fn = between(src, 'export async function planAcceptedAction(', 'export async function executeQueuedRunAction(');
    expect(fn).toContain("select('id, title, description, location, planned_for, budget_cents, status')");
    expect(at(fn, 'if (plan.status !== nextStatus)')).toBeLessThan(at(fn, 'const { decision, approvalId } = await evaluateTrust('));
  });
});

describe('accepting a quote is one chain that stops where it fails (C1-S9-79)', () => {
  const src = readFileSync('components/modules/projects-module.tsx', 'utf8');
  const fn = between(src, 'async function setQuoteStatus(q: Quote, status: ProjectQuoteStatus) {', 'async function deleteQuote(q: Quote) {');

  it('the acceptance is set and confirmed before any other quote is declined', () => {
    expect(at(fn, 'if (wroteNoRows(set))')).toBeLessThan(at(fn, "update({ status: 'declined' })"));
  });

  it('the demotion is confirmed by count before the project is linked', () => {
    expect(at(fn, '(demoted?.length ?? 0) !== others.length')).toBeLessThan(at(fn, ".from('home_projects').update("));
  });

  it('success is said only after the link lands, and never after a failed one', () => {
    expect(fn).toContain('if (linkError) return toastError(');
    expect(at(fn, 'if (wroteNoRows(linked))')).toBeLessThan(at(fn, 'success(`Accepted'));
  });
});

describe('a write that licenses the next one is confirmed before it (C1-S9-80)', () => {
  it('career: the new primary is set and confirmed before the others are cleared', () => {
    const src = readFileSync('components/modules/career-module.tsx', 'utf8');
    const fn = between(src, 'async function setPrimary(r: Resume) {', 'async function deleteResume(');
    expect(at(fn, 'if (wroteNoRows(made))')).toBeLessThan(at(fn, 'update({ is_primary: false })'));
    // Clearing the others is NOT confirmed: there is often no other primary.
    expect(fn).not.toMatch(/is_primary: false \}\)[^;]*\.select\(/);
  });

  it('declutter: a completed mission is confirmed before its session is logged', () => {
    const src = readFileSync('components/modules/declutter-module.tsx', 'utf8');
    expect(at(src, 'if (wroteNoRows(completed))')).toBeLessThan(at(src, ".from('declutter_sessions').insert("));
  });

  it('inventory: an item move is confirmed before its history row is written', () => {
    const src = readFileSync('components/modules/inventory-module.tsx', 'utf8');
    // Scoped to MoveForm: another handler earlier in the file inserts into
    // inventory_moves too, and an unscoped at() would find that one first.
    const form = src.slice(at(src, 'function MoveForm('));
    expect(at(form, 'if (wroteNoRows(moved))')).toBeLessThan(at(form, ".from('inventory_moves').insert("));
  });
});

describe('closet: every wear-count bump is confirmed before the outfit is called logged (C1-S9-81)', () => {
  it('each bump asks for its row, and a bump that matched nothing is reported', () => {
    const src = readFileSync('components/modules/closet-module.tsx', 'utf8');
    expect(src).toContain(".update({ wear_count: (current?.wear_count ?? 0) + 1, last_worn_on: todayIso() }).eq('id', id).select('id');");
    expect(at(src, 'if (results.some((r) => wroteNoRows(r.data)))')).toBeLessThan(at(src, "success(t('closetModule.loggedTodaySOutfit'))"));
  });
});

describe('a row that licenses the next write is confirmed before it (C1-S9-82)', () => {
  it('photos: the file is removed only after the row delete is confirmed', () => {
    const src = readFileSync('components/modules/photos-module.tsx', 'utf8');
    const fn = between(src, 'async function deletePhoto(', 'async function updateCaption(');
    expect(fn).toContain(".from('family_photos').delete().eq('id', photo.id).select('id')");
    expect(at(fn, 'if (wroteNoRows(removedRow))')).toBeLessThan(at(fn, ".storage.from('family-media').remove("));
  });

  it('routines: a template edit is confirmed before its steps are cleared and replaced', () => {
    const src = readFileSync('components/modules/routines-panel.tsx', 'utf8');
    const fn = bodyOf(src, 'async function save() {', '\n  }\n');
    expect(at(fn, 'if (wroteNoRows(renamed))')).toBeLessThan(at(fn, ".from('routine_template_items').delete()"));
    expect(at(fn, ".from('routine_template_items').delete()")).toBeLessThan(at(fn, ".from('routine_template_items').insert("));
  });

  it('expenses: a split rollback that matched nothing is logged, not silent', () => {
    const src = readFileSync('components/modules/expenses-module.tsx', 'utf8');
    expect(src).toContain(".from('expense_splits').delete().eq('id', split.id).select('id')");
    expect(at(src, 'if (rollbackError)')).toBeLessThan(at(src, 'else if (wroteNoRows(rolledBack)) console.error('));
  });

  it('two writes stay unconfirmed on purpose, and say why', () => {
    // Zero rows is a legitimate answer for both: nothing was unread, and a
    // template with no steps written. Confirming them would refuse a success.
    const notifications = readFileSync('components/modules/notifications-module.tsx', 'utf8');
    const all = bodyOf(notifications, 'async function markAllRead() {', '\n  }\n');
    expect(all).toContain(".update({ is_read: true })");
    expect(all).not.toContain(".select(");
    expect(all).toContain('Audit C1-S9-82');
    const routines = readFileSync('components/modules/routines-panel.tsx', 'utf8');
    const clear = at(routines, ".from('routine_template_items').delete()");
    const clearLine = routines.slice(clear, routines.indexOf('\n', clear));
    expect(clearLine).not.toContain('.select(');
    const lead = routines.slice(0, clear).split('\n').slice(-12).join('\n');
    expect(lead).toContain('Audit C1-S9-82');
  });
});

describe('access, defaults and undo say only what landed (C1-S9-83)', () => {
  it('weather: the new default is set and confirmed before the OTHER cities are cleared', () => {
    const src = readFileSync('components/modules/weather-module.tsx', 'utf8');
    const fn = bodyOf(src, 'async function makeDefault(', '\n  }\n');
    expect(at(fn, 'if (!rows?.length)')).toBeLessThan(at(fn, 'update({ is_default: false })'));
    // Only the others, and unconfirmed on purpose: with one city there are none.
    expect(fn).toContain(".update({ is_default: false }).eq('family_id', familyId).neq('id', id))");
    expect(fn).not.toMatch(/is_default: false \}\)[^;]*\.select\(/);
    expect(fn).toContain('Audit C1-S9-83');
  });

  it('create-memory: undo removes only the files whose rows are confirmed gone', () => {
    const src = readFileSync('components/memories/create-memory.tsx', 'utf8');
    const fn = bodyOf(src, 'async function undo(', '\n  }\n');
    expect(fn).toContain(".from('family_photos').delete().in('id', ids).select('id')");
    expect(at(fn, 'const paths = created.filter((c) => gone.has(c.id))')).toBeLessThan(at(fn, ".storage.from('family-media').remove(paths)"));
    // A survivor stops the flow before "undone" is said.
    expect(at(fn, 'if (survivors.length)')).toBeLessThan(at(fn, "success(t('createMemory.memoryUndoneNothingWasSaved'))"));
    expect(fn).not.toContain('const paths = created.map(');
  });

  it('settings, connections, chores, decisions: the zero-row check precedes the claim', () => {
    const settings = readFileSync('components/modules/settings-module.tsx', 'utf8');
    expect(at(settings, 'if (wroteNoRows(edited))')).toBeLessThan(at(settings, "success(t('settingsModule.memberUpdated'))"));
    const connections = readFileSync('components/modules/connections-module.tsx', 'utf8');
    expect(connections).toContain(".delete().eq('family_id', familyId).eq('provider', p.id).select('id')");
    expect(at(connections, 'if (wroteNoRows(removed))')).toBeLessThan(at(connections, 'success(`${p.name} disconnected`)'));
    const chores = readFileSync('components/modules/chores-module.tsx', 'utf8');
    expect(at(chores, 'if (wroteNoRows(approved))')).toBeLessThan(at(chores, 'success(`Approved! +${a.chore?.points ?? 0} pts`)'));
    const decisions = readFileSync('components/modules/decisions-module.tsx', 'utf8');
    expect(at(decisions, 'if (results.some((x) => wroteNoRows(x.data)))')).toBeLessThan(at(decisions, "success(t('decisionsModule.scoresSavedToTheDecision'))"));
  });

  it("meals: the prior-ballot clear stays unconfirmed on purpose — a first vote has none", () => {
    const src = readFileSync('components/modules/meals-module.tsx', 'utf8');
    const fn = bodyOf(src, 'async function castVote(', '\n  }\n');
    expect(fn).toContain(".delete().eq('vote_id', voteData.vote.id).eq('member_id', selfId);");
    expect(fn).toContain('Audit C1-S9-83');
  });
});

describe('a refused listing save lets go of nothing it uploaded (C1-S9-85)', () => {
  it('marketplace: zero rows takes the failure path, photo cleanup included', () => {
    const src = readFileSync('components/modules/marketplace-module.tsx', 'utf8');
    expect(src).toContain('if (err || wroteNoRows(saved)) {');
    expect(at(src, 'if (err || wroteNoRows(saved)) {')).toBeLessThan(at(src, 'await cleanupOwnedPhoto();'));
    expect(at(src, 'await cleanupOwnedPhoto();')).toBeLessThan(at(src, "success(form.id ? 'Listing updated' : 'Posted to the family marketplace')"));
  });

  it('reminders: both attempts read back their row, and zero rows stops the claim', () => {
    const src = readFileSync('components/modules/reminders-module.tsx', 'utf8');
    // The save reaches .select('id') through a local `run` helper, which no
    // binding regex can see — so this is checked here, in its own function.
    const helper = bodyOf(src, 'const run = (uStrip: typeof fullUpdate, iStrip: typeof fullInsert) => reminder', ';\n');
    expect(helper).toContain(".update(uStrip).eq('id', reminder.id).select('id')");
    expect(helper).toContain(".insert(iStrip).select('id')");
    expect(src).toContain('({ data: saved, error } = await run(stripNewCols(fullUpdate), stripNewCols(fullInsert)));');
    expect(at(src, 'let { data: saved, error } = await run(fullUpdate, fullInsert);')).toBeLessThan(at(src, "if (wroteNoRows(saved)) { toastError(tr('errors.thatChangeWasNotSaved')); return; }"));
    expect(at(src, "if (wroteNoRows(saved)) { toastError(tr('errors.thatChangeWasNotSaved')); return; }")).toBeLessThan(at(src, "success(reminder ? 'Reminder updated' : 'Reminder created')"));
  });
});

describe('the last thirteen modules (C1-S9-86)', () => {
  it('assistant: a conversation leaves the list only when its row is confirmed gone', () => {
    const src = readFileSync('components/modules/assistant-module.tsx', 'utf8');
    const fn = bodyOf(src, 'async function deleteConversation(', '\n  }\n');
    expect(at(fn, 'if (wroteNoRows(removed))')).toBeLessThan(at(fn, 'setConversations((prev) => prev.filter((c) => c.id !== id));'));
    const rename = bodyOf(src, 'async function renameConversation(', '\n  }\n');
    expect(at(rename, 'if (wroteNoRows(renamed))')).toBeLessThan(at(rename, 'setConversations((prev) => prev.map('));
  });

  it('tax vault and trip memories keep object-first, and a refused row is not "deleted"', () => {
    for (const [file, table, ok] of [
      ['components/modules/tax-vault-module.tsx', 'tax_documents', "success(t('taxVaultModule.deleted'))"],
      ['components/modules/trip-memories-module.tsx', 'trip_memories', "success(t('tripMemoriesModule.deleted'))"],
    ] as const) {
      const src = readFileSync(file, 'utf8');
      expect(at(src, 'if (storageError)')).toBeLessThan(at(src, `from('${table}').delete()`));
      expect(at(src, `from('${table}').delete()`)).toBeLessThan(at(src, 'wroteNoRows(removed)'));
      expect(at(src, 'wroteNoRows(removed)')).toBeLessThan(at(src, ok));
    }
  });
});

describe('completing a recurring reminder schedules its next occurrence once (C1-S9-77)', () => {
  const src = readFileSync('components/modules/reminders-module.tsx', 'utf8');
  const fn = between(src, 'function complete(reminder: Reminder) {', 'function toggleSubtask(');

  it('a completion that matched nothing returns before the next occurrence is built', () => {
    expect(at(fn, 'if (wroteNoRows(completedRows))')).toBeLessThan(at(fn, 'nextRemindAt('));
    expect(at(fn, 'if (wroteNoRows(completedRows))')).toBeLessThan(at(fn, ".from('family_reminders').insert(nextRow)"));
  });

  it('an already-completed reminder matches nothing; a snoozed one can still be completed', () => {
    expect(fn).toContain(".neq('status', 'completed').select('id')");
    // Not eq('active'): a snoozed reminder shows the same button.
    expect(fn).not.toContain(".eq('status', 'active')");
  });
});
