// The one-tap reminder buttons go through the service, and the ones that don't
// are named rather than forgotten.
//
// The behavioural half lives in `reminder-write-path.test.ts`; this is the
// structural half a node-environment test cannot otherwise reach, since a
// passing action is exactly what a module still inserting into PostgREST would
// leave behind.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The four surfaces whose reminder create was rejected by the CHECK constraints. */
const CONVERTED = [
  'components/modules/front-desk-module.tsx',
  'components/modules/inbox-module.tsx',
  'components/modules/autopilot-module.tsx',
  'app/(app)/dashboard/paperwork/actions.ts',
];

/**
 * `reminders-module` is converted only for `quickAdd`. Its rich editor, its
 * recurrence respawn, its complete/snooze/delete still write directly, and
 * NOT because they were skipped:
 *
 *   1. `CreateReminderInput` cannot express the six columns migration 0100 added
 *      (url, flagged, early_reminder_minutes, image_url, subtasks, list_id), so
 *      routing the editor through it would silently drop what a family typed.
 *   2. The module deliberately RETRIES with those columns stripped when the
 *      schema lacks them (`stripNewCols`). The service has no such tolerance, so
 *      routing would also remove a guard against an unapplied 0100.
 *   3. `completeReminder` rolls a recurring reminder forward IN PLACE; the module
 *      spawns a new row and keeps the completed one as history, "like iOS".
 *      Those are different data, both defensible — a product decision, not a
 *      call-site change.
 */
const PARTIALLY_CONVERTED = 'components/modules/reminders-module.tsx';

const REMINDER_WRITE = /\.from\(\s*['"]family_reminders['"]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\s*\(/g;

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}

const writesIn = (file: string) => [...code(file).matchAll(REMINDER_WRITE)].map((m) => m[1]!);

describe('the surfaces whose reminder create was rejected', () => {
  it.each(CONVERTED)('%s issues no direct write to family_reminders', (file) => {
    expect(writesIn(file)).toEqual([]);
  });

  it.each(CONVERTED)('%s creates through the service instead', (file) => {
    const src = code(file);
    // The three client modules go through the action; the paperwork server
    // action already had a scope and calls the service directly.
    expect(
      /from '@\/app\/\(app\)\/dashboard\/reminders\/actions'/.test(src)
        || /from '@\/lib\/services\/reminders'/.test(src),
    ).toBe(true);
  });

  it.each(CONVERTED.filter((f) => f.endsWith('.tsx')))('%s mints a submission id for each create', (file) => {
    const src = code(file);
    const creates = (src.match(/createReminderAction\(/g) ?? []).length;
    expect(creates).toBeGreaterThan(0);
    expect(src).toMatch(/from '@\/lib\/utils\/submission-id'/);
    expect((src.match(/submissionId:/g) ?? []).length).toBe(creates);
  });
});

describe('the reminders module, converted only where it can be', () => {
  it('routes its quick-add through the action', () => {
    const src = code(PARTIALLY_CONVERTED);
    expect(src).toMatch(/from '@\/app\/\(app\)\/dashboard\/reminders\/actions'/);
    expect(src).toMatch(/createReminderAction\(/);
  });

  it('still writes directly for the editor and the recurrence respawn', () => {
    // Fails the day someone converts them, which is the point: doing so needs
    // the service to grow the 0100 columns first, and needs the recurrence
    // question answered. Neither is a silent edit.
    expect(writesIn(PARTIALLY_CONVERTED).length).toBeGreaterThan(0);
  });

  it('keeps its tolerance for an unapplied 0100', () => {
    // `stripNewCols` retries without the columns 0100 added. The service has no
    // equivalent, so this guard has to survive until the service does.
    const src = code(PARTIALLY_CONVERTED);
    expect(src).toMatch(/stripNewCols/);
    expect(src).toMatch(/isMissingRelationError/);
  });
});
