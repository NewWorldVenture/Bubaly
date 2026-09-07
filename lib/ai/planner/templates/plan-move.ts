// Plan the move (M14). Owner: the Household Manager.
//
// The Move Planner already knows the ten-week template; what a family cannot
// get from a template is THEIR list — the seven subscriptions that need a new
// address, the school that holds Maya's records, the vet Biscuit goes to. The
// `moving` context slice reads those rows, and this template multiplies them
// into one dated task each (`dynamicSteps`), every one with a stable
// `template_key` so asking twice adds nothing twice.
//
// Every task step takes `move_id: null`, which the moving tools read as "the
// family's current move". That is what lets the skeleton run whether or not a
// move is on file yet: when there is none, the first step puts it on file and
// everything after resolves to it at execution time.
import { localTime, shiftDay, type MoveContext, type TemplateContext, type TemplateStep, type WorkflowTemplate } from './index';

/** Caps keep the plan under MAX_STEPS (40) with the eight fixed steps in place. */
const MAX_SUBSCRIPTIONS = 10;
const MAX_BILLS = 8;
const MAX_SCHOOLS = 4;
const MAX_PETS = 4;

/** The service's default lead time when a move is put on file without a date. */
const DEFAULT_LEAD_DAYS = 45;

const UTILITY_RE = /\b(electric|electricity|power|energy|gas|water|sewer|internet|broadband|wifi|fiber|fibre|cable|phone|mobile|cellular|trash|garbage|recycling|heating|oil)\b/i;

function moveOf(ctx: TemplateContext): MoveContext['move'] {
  return ctx.move?.move ?? null;
}

function moveDateKey(ctx: TemplateContext): string {
  return moveOf(ctx)?.moveDate ?? shiftDay(ctx.todayKey, DEFAULT_LEAD_DAYS);
}

/** The manager who owns the admin: the person asking when they manage the family, otherwise the first manager. */
function ownerId(ctx: TemplateContext): string | null {
  if (ctx.viewerMemberId && ctx.managerIds.includes(ctx.viewerMemberId)) return ctx.viewerMemberId;
  return ctx.managerIds[0] ?? null;
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

function taskStep(key: string, description: string, input: Record<string, unknown>): TemplateStep {
  return {
    key, stepType: 'act', toolName: 'moving.addTask', description, dependsOn: ['timeline'],
    input: () => ({ move_id: null, ...input }),
  };
}

export const planMoveTemplate: WorkflowTemplate = {
  intent: 'plan_move',
  agent: 'household_manager',
  title: 'Plan the move',
  deterministic: false,
  objective: (ctx) => {
    const move = moveOf(ctx);
    return move
      ? `Get the family ready for ${move.title} on ${move.moveDate}: the dated checklist, every address change, school and vet records, and the reminders that keep it on track.`
      : 'Put the move on file and lay out the dated checklist, address changes, school and vet records, and the reminders that keep it on track.';
  },
  guidance: [
    'When the context shows a move on file, drop the put_move_on_file step. When it shows none, fill put_move_on_file from the request (title, move date, addresses) and keep every other step — they address the current move.',
    'Keep every address_, bill_, school_ and vet_ step the skeleton lists: each one names a real subscription, bill, school or pet from the context. Never add an address change for a service the context does not show.',
    'A task with an offset_days follows the move date if it changes; only use due_date for something with a genuinely fixed date.',
    'Assign admin tasks to a parent; a records request for a child goes to a parent, never to the child.',
    'Rewrite the notification body with what is now dated, how many address changes were added, and the first three things due.',
  ],
  steps: [
    {
      key: 'put_move_on_file', stepType: 'act', toolName: 'moving.createMove', description: 'Put the move on file',
      input: (ctx) => ({ title: ctx.entities.title ?? ctx.entities.destination ?? null, move_date: ctx.entities.move_date ?? ctx.entities.date ?? null, to_address: ctx.entities.destination ?? ctx.entities.address ?? null }),
      modelFills: 'title, move_date and to_address from the request — only when no move is on file', optional: true,
    },
    { key: 'move', stepType: 'retrieve', toolName: 'moving.getMove', description: 'Read the move and what is already planned', input: () => ({ move_id: null }) },
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'See who is in the household', input: () => ({}) },
    {
      key: 'timeline', stepType: 'act', toolName: 'moving.planTasks', description: 'Lay out the eight-weeks-before to two-weeks-after checklist',
      dependsOn: ['move'], input: () => ({ move_id: null }),
    },
    {
      key: 'address_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind the family two weeks out about mail forwarding and address changes',
      dependsOn: ['timeline'],
      input: (ctx) => ({ title: 'Move in two weeks: mail forwarding and address changes', remind_at: localTime(shiftDay(moveDateKey(ctx), -14), 9), kind: 'time', priority: 'high', assignee_id: ownerId(ctx) }),
    },
    {
      key: 'eve_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind the family the evening before moving day',
      dependsOn: ['timeline'],
      input: (ctx) => ({ title: 'Moving day tomorrow: essentials box, keys, meter readings, cash for the crew', remind_at: localTime(shiftDay(moveDateKey(ctx), -1), 18), kind: 'time', priority: 'high' }),
    },
    {
      key: 'check_reminders', stepType: 'verify', description: 'Check the move reminders are really set',
      dependsOn: ['address_reminder', 'eve_reminder'],
      input: () => ({
        checks: [
          { kind: 'records_exist', table: 'family_reminders', ids: [{ $fromStep: 'address_reminder', path: 'id' }, { $fromStep: 'eve_reminder', path: 'id' }], label: 'The move reminders are set' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Tell the parents what is dated and what is still open',
      dependsOn: ['timeline', 'address_reminder', 'eve_reminder', 'check_reminders'],
      input: () => ({ recipients: 'managers', type: 'system', title: 'Your move plan is ready', body: '' }),
      modelFills: 'body: what is now dated, the address changes added, the records to request, and the first three things due',
    },
  ],
  dynamicSteps: (ctx) => {
    const sources = ctx.move;
    if (!sources) return [];
    const owner = ownerId(ctx);
    const steps: TemplateStep[] = [];

    sources.subscriptions.slice(0, MAX_SUBSCRIPTIONS).forEach((sub, i) => {
      steps.push(taskStep(`address_${i + 1}`, `Change the address with ${sub.name}`, {
        title: `Change the address with ${sub.name}`, category: 'address', offset_days: -14, assignee_id: owner, template_key: `address-sub-${sub.id}`,
      }));
    });
    sources.bills.slice(0, MAX_BILLS).forEach((bill, i) => {
      const utility = UTILITY_RE.test(`${bill.name} ${bill.category ?? ''}`);
      steps.push(taskStep(`bill_${i + 1}`, utility ? `Move ${bill.name} to the new address` : `Update the billing address with ${bill.name}`, {
        title: utility ? `Move ${bill.name} to the new address` : `Update the billing address with ${bill.name}`,
        category: utility ? 'utilities' : 'address', offset_days: utility ? -21 : -14, assignee_id: owner, template_key: `address-bill-${bill.id}`,
      }));
    });
    sources.schoolClasses.slice(0, MAX_SCHOOLS).forEach((cls, i) => {
      const who = cls.memberName ?? 'the child';
      const title = `Request ${possessive(who)} school records${cls.schoolName ? ` from ${cls.schoolName}` : ''}`;
      steps.push(taskStep(`school_${i + 1}`, title, { title, category: 'school', offset_days: -49, assignee_id: owner, template_key: `school-records-${cls.memberId}` }));
    });
    sources.pets.slice(0, MAX_PETS).forEach((pet, i) => {
      const title = `Get ${possessive(pet.name)} records and vaccine certificate from ${pet.vetName ?? 'the vet'}`;
      steps.push(taskStep(`vet_${i + 1}`, title, { title, category: 'pets', offset_days: -35, assignee_id: owner, template_key: `vet-records-${pet.id}` }));
    });
    return steps;
  },
  followups: (ctx) => {
    const move = moveOf(ctx);
    if (!move) return [];
    return [{ after: localTime(shiftDay(move.moveDate, -2), 9), prompt: `Two days before ${move.title}: check the open move tasks and escalate anything still open to a parent.` }];
  },
};
