// §7, repo-wide: where does a component still write a table the service layer
// already owns?
//
// Every §7 tranche so far shipped a structural guard scoped to ONE file — the
// module it converted. That proves the module is clean and NOTHING ELSE, and it
// is how `next-actions-module.tsx` kept updating `todo_items` directly, filtering
// `id` alone, through a tranche whose report said `todo_items` was at zero
// browser writes. A per-file guard cannot support a per-table claim.
//
// So the claim is made here, once, over every component in the repo: for each
// table the service layer writes, the set of components that ALSO write it must
// be exactly what `KNOWN_FORKS` says. Converting one is deleting a line; adding
// one fails until it is written down with a reason.
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRITE = /from\('([a-z_]+)'\)\s*\.\s*(?:insert|update|delete|upsert)/g;

/** Comments quote the code they replaced, so a guard reading them would find its own explanation. */
function code(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function writesByTable(paths: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of paths) {
    for (const [, table] of code(path).matchAll(WRITE)) {
      const files = found.get(table) ?? [];
      if (!files.includes(path)) files.push(path);
      found.set(table, files);
    }
  }
  return found;
}

const serviceWrites = writesByTable(globSync('lib/services/**/*.ts'));
const clientWrites = writesByTable(globSync('components/**/*.{ts,tsx}'));

/**
 * The forks that remain, each with why it is still here. A table is listed only
 * if the SERVICE also writes it — a table the service layer does not own yet is
 * a different question from a table it owns and the browser writes around.
 */
const KNOWN_FORKS: Record<string, string> = {
  // Converted paths whose remaining write is deliberate, and named where it was decided:
  chore_assignments: 'the board’s approval — two approval paths pay a child differently (a product decision that moves money)',
  family_reminders: 'six writes needing 0100’s columns or the recurring-completion decision',
  grocery_lists: 'ensureDefaultList takes no icon or colour, so routing would change what a new list looks like',
  todo_lists: 'ensureTodoList takes no icon or colour, same reason',
  event_rsvps: 'the RSVP write is already family-scoped through its event',

  // Not yet reached by a §7 tranche. Listed so the number is honest rather than
  // implied, and so converting one is a deliberate edit to this file.
  family_announcements: 'not yet converted',
  family_conversations: 'not yet converted',
  family_messages: 'not yet converted',
  // Connected-calendar onboarding adds service-owned parent provisioning. The
  // existing Family and Settings membership editors remain a separate tranche.
  family_members: 'onboarding service now provisions the owner; family-module.tsx and settings-module.tsx still own their existing membership CRUD',
  family_recipes: 'not yet converted',
  ai_conversations: 'components/modules/assistant-module.tsx still renames and deletes the current user’s chats under owner RLS; the S12 private-result service adds conversation creation for purchase reports, not a conversion of those existing controls',
  home_assets: 'not yet converted',
  // M13/M14 gave these four a service so the ASSISTANT could reach them
  // (inventory.find / inventory.recordMove / moving.planTasks / moving.setMoveDate).
  // That is a new caller, not a conversion: inventory-module.tsx and
  // moving-module.tsx still do their own CRUD from the browser exactly as
  // before. Listed rather than converted so the number stays honest — the
  // modules are a §7 tranche of their own.
  inventory_items: 'service added for the assistant’s tools (M13); the module’s own CRUD is not converted yet',
  inventory_moves: 'same — recordMove is the tool path, the module still inserts its own moves',
  move_tasks: 'service added for the assistant’s tools (M14); the module’s own CRUD is not converted yet',
  moves: 'same — planTasks/setMoveDate are the tool path, the module still writes the move row',
  // The memory work (M22) gave routines a service so the "what Bubaly
  // believes" view could list and reset them. routines-panel.tsx still creates,
  // renames and deletes its own templates straight from the browser — a new
  // caller, not a conversion, exactly like the M13/M14 pair above.
  routine_templates: 'service added for the memory view (M22); the panel’s own CRUD is not converted yet',
  maintenance_tasks: 'not yet converted',
  meals: 'not yet converted',
  notifications: 'not yet converted',
  vacation_budgets: 'not yet converted',
  vacation_itinerary_days: 'not yet converted',
  vacation_itinerary_items: 'not yet converted',
  vacation_packing_items: 'not yet converted',
  vacation_packing_lists: 'not yet converted',
  vacations: 'not yet converted',
};

describe('the service layer owns its tables', () => {
  it('sweeps a real corpus, so an empty result would mean something', () => {
    // Without this the assertions below could pass by finding nothing at all.
    expect(globSync('components/**/*.{ts,tsx}').length).toBeGreaterThan(300);
    expect(serviceWrites.size).toBeGreaterThan(20);
  });

  it('has no browser write to a service-owned table that is not written down', () => {
    const forks = [...clientWrites.keys()].filter((t) => serviceWrites.has(t)).sort();
    const undeclared = forks.filter((t) => !(t in KNOWN_FORKS));
    expect(undeclared, `new fork(s) — convert them, or add them to KNOWN_FORKS with a reason`).toEqual([]);
  });

  it('lists nothing that is already clean', () => {
    // The other half: a table converted but left in the list would overstate the
    // work remaining, and hide the fact that the conversion is finished.
    const stale = Object.keys(KNOWN_FORKS).filter((t) => !clientWrites.has(t));
    expect(stale, 'no component writes these any more — delete them from KNOWN_FORKS').toEqual([]);
  });

  it('confines the legacy conversation controls to their existing component', () => {
    expect((clientWrites.get('ai_conversations') ?? []).map((path) => path.replace(/\\/g, '/')))
      .toEqual(['components/modules/assistant-module.tsx']);
  });

  it('keeps the tables the §7 tranches closed at zero', () => {
    // The four claims that were true, now proven over every component rather
    // than over the one module each tranche happened to convert.
    for (const table of ['calendar_events', 'todo_items', 'meal_plans', 'grocery_items', 'agent_activity', 'audit_logs']) {
      expect(clientWrites.get(table) ?? [], `${table} is written from the browser`).toEqual([]);
    }
  });
});
