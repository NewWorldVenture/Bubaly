// A click that destroys a record asks first — and asks in the reader's language.
//
// The audit found the medical and money modules deleting on a single tap with no
// confirmation at all. Measuring the class turned up 40 such clicks across 27
// files, and — reading what the confirmed ones actually say — a second defect
// underneath it: 32 places ask through `window.confirm()` with a hardcoded
// ENGLISH template literal. A German reader about to delete a move plan gets
// "Delete “X” with all its tasks and boxes? This cannot be undone." That is worse
// than a hardcoded number format: it is an irreversible action gated on a
// question the reader may not be able to read.
//
// Two inventories are pinned here, by NAME rather than by count. A count falls as
// the work succeeds, which turns the scanner's blind spots into false assurance;
// a named list fails loudly both when a new site appears AND when a listed one is
// fixed without being struck off.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const files = () =>
  execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const DELETES = /\.delete\(\)|delete[A-Z]\w*Action\(|\.remove\(\[/;
// Every shape the app uses to gate a destructive handler, including the raw
// browser dialog it is being moved off.
const ASKS = /askConfirm\(|confirm\(|setConfirm|ConfirmModal|<Modal|confirmingId|pendingDelete|askDelete/;

const isFnLike = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

/** Handlers that delete, reached from an onClick, with nothing on that path that asks. */
function unconfirmedClicks(): string[] {
  const hits: string[] = [];
  for (const file of files()) {
    const source = readFileSync(file, 'utf8');
    if (!DELETES.test(source)) continue;
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const deleting = new Map<string, boolean>();
    const visit = (node: ts.Node) => {
      const name =
        (ts.isFunctionDeclaration(node) && node.name?.text) ||
        (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && isFnLike(node.initializer) && node.name.text) || null;
      if (name) {
        const text = node.getText();
        if (DELETES.test(text)) deleting.set(name, ASKS.test(text));
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(src, visit);
    for (const [name, asks] of deleting) {
      if (asks) continue;
      const re = new RegExp(`onClick=\\{[^}]{0,160}?(?<![\\w.])${name}\\(`, 'g');
      for (const m of source.matchAll(re)) {
        if (ASKS.test(m[0])) continue;
        hits.push(`${file}::${name}`);
      }
    }
  }
  return [...new Set(hits)].sort();
}

/** `confirm(...)` calls whose message is a literal rather than a t() lookup. */
function englishAsks(): string[] {
  const hits: string[] = [];
  for (const file of files()) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(?<![\w.])confirm\(\s*['"`]/g)) {
      hits.push(`${file}:${source.slice(0, m.index).split('\n').length}`);
    }
  }
  return hits.sort();
}

// The handlers that now ask through the shared primitive, with the key each one
// asks with. They are asserted individually: a guard that only counted would go
// green if one of them silently lost its question.
const ADOPTED: [string, string, string][] = [
  ['components/modules/medical-records-module.tsx', 'deletePolicy', 'medicalRecords.deletePolicyQ'],
  ['components/modules/medical-records-module.tsx', 'deleteProvider', 'medicalRecords.deleteProviderQ'],
  ['components/modules/medications-module.tsx', 'deleteSchedule', 'medications.deleteScheduleQ'],
  ['components/modules/billing-module.tsx', 'deleteTransaction', 'billing.deleteTransactionQ'],
  ['components/modules/billing-module.tsx', 'deleteBudget', 'billing.deleteBudgetQ'],
  ['components/modules/billing-module.tsx', 'deleteGoal', 'billing.deleteGoalQ'],
  ['components/modules/billing-module.tsx', 'deleteBill', 'billing.deleteBillQ'],
  ['components/modules/billing-module.tsx', 'deleteAccount', 'billing.deleteAccountQ'],
  ['components/modules/home-module.tsx', 'removeFile', 'home.deleteFileQ'],
  ['components/modules/home-module.tsx', 'removeAsset', 'home.deleteAssetQ'],
  ['components/modules/pets-module.tsx', 'deleteRecord', 'pets.deleteRecordQ'],
  ['components/modules/projects-module.tsx', 'deleteQuote', 'projects.deleteQuoteQ'],
  ['components/modules/projects-module.tsx', 'deleteMaterial', 'projects.deleteMaterialQ'],
  ['components/guardian/rules-editor.tsx', 'handleDelete', 'rulesEditor.deleteRuleQ'],
  ['components/modules/health-module.tsx', 'deleteSymptom', 'health.deleteSymptomQ'],
  ['components/modules/language-module.tsx', 'deleteCard', 'language.deleteCardQ'],
];

// Still unconfirmed, and deliberately so for now: each deletes a row a person
// re-enters in one tap — a city, a packing item, a gift idea, a vote — or is a
// toggle the scan reads as a delete because it clears a row to write another
// (`vote`, `castVote`, `logDose`). Striking one off means it now asks.
const STILL_UNCONFIRMED = [
  'components/family/check-in-view.tsx::remove',
  'components/meals/nutrition-view.tsx::remove',
  'components/modules/announcements-module.tsx::remove',
  'components/modules/celebrations-module.tsx::remove',
  'components/modules/contact-timeline-module.tsx::remove',
  'components/modules/event-detail-modal.tsx::deleteEvent',
  'components/modules/kitchen-dashboard.tsx::remove',
  'components/modules/language-module.tsx::deleteSession',
  'components/modules/medications-module.tsx::logDose',
  'components/modules/relationship-module.tsx::removeGift',
  'components/modules/reminders-module.tsx::deleteReminder',
  'components/modules/sleep-module.tsx::deleteLog',
  'components/modules/trips-module.tsx::removeItem',
  'components/modules/voice-module.tsx::remove',
  'components/modules/voting-module.tsx::vote',
  'components/modules/watchlist-module.tsx::castVote',
  'components/modules/watchlist-module.tsx::deleteSession',
  'components/modules/weather-module.tsx::removeCity',
  'components/modules/weekend-module.tsx::removePlan',
  'components/twin/activity-projection.tsx::remove',
  'components/vacations/trip-packing.tsx::remove',
];

// Asks that are still hardcoded English. This list is EMPTY and stays empty: all
// 32 now go through the shared primitive, so a file appearing here is a new
// English confirmation, not a leftover one.
const ENGLISH_ASKS: string[] = [];

// The 32 confirmations that used to be English literals. Each is asserted on a
// property rather than on its wording: NOTHING IS AWAITED BEFORE THE QUESTION.
// That is what a confirmation has to mean — a handler that fires its request and
// then asks has not asked at all — and it holds whether the handler deletes, or
// disconnects, or retires.
const CONVERTED: [string, string][] = [
  ['components/admin/admin-row-actions.tsx', '<inline>'],
  ['components/dashboard/calendar-sync-panel.tsx', 'remove'],
  ['components/modules/career-module.tsx', 'deleteApplication'],
  ['components/modules/career-module.tsx', 'deleteResume'],
  ['components/modules/career-module.tsx', 'deleteProfile'],
  ['components/modules/closet-module.tsx', 'deleteItem'],
  ['components/modules/closet-module.tsx', 'deleteOutfit'],
  ['components/modules/connections-module.tsx', 'disconnect'],
  ['components/modules/declutter-module.tsx', 'deleteMission'],
  ['components/modules/homework-module.tsx', 'remove'],
  ['components/modules/inventory-module.tsx', 'deleteItem'],
  ['components/modules/inventory-module.tsx', 'deleteLocation'],
  ['components/modules/knowledge-base-module.tsx', 'remove'],
  ['components/modules/language-module.tsx', 'deleteGoal'],
  ['components/modules/marketplace-module.tsx', 'remove'],
  ['components/modules/medications-module.tsx', 'deleteMed'],
  ['components/modules/moving-module.tsx', 'deleteTask'],
  ['components/modules/moving-module.tsx', 'deleteBox'],
  ['components/modules/moving-module.tsx', 'deleteMove'],
  ['components/modules/projects-module.tsx', 'deleteProject'],
  ['components/modules/relationship-module.tsx', 'removeDate'],
  ['components/modules/renewals-module.tsx', 'remove'],
  ['components/modules/rewards-module.tsx', 'remove'],
  ['components/modules/rides-module.tsx', 'remove'],
  ['components/modules/routines-panel.tsx', 'deleteTemplate'],
  ['components/modules/signups-module.tsx', 'remove'],
  ['components/modules/sleep-module.tsx', 'archiveRoutine'],
  ['components/modules/timetable-module.tsx', 'remove'],
  ['components/modules/trips-module.tsx', 'removeTrip'],
  ['components/modules/watchlist-module.tsx', 'deleteTitle'],
  ['components/modules/wishlists-module.tsx', 'remove'],
  ['components/wallet/wallet-hub.tsx', 'del'],
];

describe('a destructive click asks first', () => {
  it.each(ADOPTED)('%s :: %s asks before it deletes', (file, handler, key) => {
    const source = readFileSync(file, 'utf8');
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let body: string | null = null;
    const find = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === handler) body = body ?? n.getText();
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === handler
        && n.initializer && isFnLike(n.initializer)) body = body ?? n.initializer.getText();
      ts.forEachChild(n, find);
    };
    ts.forEachChild(src, find);
    expect(body, `${handler} not found in ${file}`).not.toBeNull();
    const text = body as unknown as string;
    // The ask comes before the delete, not after it.
    const asked = text.indexOf('askConfirm(');
    const deleted = text.search(DELETES);
    expect(asked, `${handler} no longer asks`).toBeGreaterThanOrEqual(0);
    expect(asked, `${handler} deletes before it asks`).toBeLessThan(deleted);
    expect(text, `${handler} asks with a different key`).toContain(`'${key}'`);
  });


  it.each(CONVERTED)('%s :: %s awaits nothing before the question', (file, handler) => {
    const source = readFileSync(file, 'utf8');
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let body: string | null = null;
    const find = (n: ts.Node) => {
      const named = (ts.isFunctionDeclaration(n) && n.name?.text === handler)
        || (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === handler
          && n.initializer !== undefined && isFnLike(n.initializer));
      if (named) body = body ?? (ts.isFunctionDeclaration(n) ? n.getText() : (n as ts.VariableDeclaration).initializer!.getText());
      // The one site that is an inline JSX handler rather than a named function.
      if (handler === '<inline>' && ts.isJsxAttribute(n) && n.name.getText() === 'onClick'
        && n.initializer && n.getText().includes('askConfirm(')) body = body ?? n.getText();
      ts.forEachChild(n, find);
    };
    ts.forEachChild(src, find);
    expect(body, `${handler} not found in ${file}`).not.toBeNull();
    const text = body as unknown as string;
    expect(text, `${handler} no longer asks`).toContain('askConfirm(');
    expect(text.indexOf('await '), `${handler} awaits something before it asks`)
      .toBe(text.indexOf('await askConfirm('));
  });

  it('asks in the reader’s language, never a bare literal', () => {
    // The primitive takes already-localised strings, so every adopted call site
    // must pass a t() lookup rather than a literal.
    for (const [file, , key] of ADOPTED) {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(new RegExp(`\\b(?:t|tr)\\('${key.replace('.', '\\.')}'\\)`));
    }
  });

  it('no new destructive click skips the question', () => {
    const found = unconfirmedClicks();
    const unexpected = found.filter((h) => !STILL_UNCONFIRMED.includes(h));
    expect(unexpected, 'a destructive click was added without a confirmation').toEqual([]);
    const fixed = STILL_UNCONFIRMED.filter((h) => !found.includes(h));
    expect(fixed, 'these now ask — strike them off STILL_UNCONFIRMED').toEqual([]);
  });

  it('the scan is not blind', () => {
    // Repair the instrument, not the list, if this goes red: it proves the scan
    // still reaches the two modules the audit named, and still sees a shape it
    // would have to see to find a regression.
    const found = unconfirmedClicks();
    expect(found).toContain('components/modules/weather-module.tsx::removeCity');
    expect(found).toContain('components/modules/voting-module.tsx::vote');
    // And the sites it used to report, which now ask, are gone from it.
    expect(found).not.toContain('components/modules/billing-module.tsx::deleteTransaction');
    expect(found).not.toContain('components/modules/medical-records-module.tsx::deletePolicy');
  });

  it('the English asks only shrink', () => {
    const found = [...new Set(englishAsks().map((h) => h.replace(/:\d+$/, '')))].sort();
    const added = found.filter((f) => !ENGLISH_ASKS.includes(f));
    expect(added, 'a confirmation was written as an English literal').toEqual([]);
    const done = ENGLISH_ASKS.filter((f) => !found.includes(f));
    expect(done, 'these ask in the reader’s language now — strike them off').toEqual([]);
  });

  it('notes no longer asks "Delete?" in English', () => {
    // The two bare confirm('Delete?') calls the audit named: uninformative AND
    // untranslated, on a surface that ships in eleven locales.
    const source = readFileSync('components/modules/notes-module.tsx', 'utf8');
    expect(source).not.toContain("confirm('Delete?')");
    expect(source.match(/askConfirm\(/g)?.length).toBe(3);
  });
});
