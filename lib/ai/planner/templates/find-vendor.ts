// Workflow D — Find a plumber (§18). Owner: the Household Manager.
//
// Bubaly has no external provider search, so the honest workflow is: work out
// the trade from the complaint, check the vendors and service history on file,
// open the maintenance record, and hand the call to a parent as a task with
// the saved contractor's details. "Never fabricate providers or availability"
// is enforced by having no step that could.
//
// Nor does Bubaly place the call. There is no outbound voice integration, so
// no step here dials, and no copy this template writes — step descriptions,
// task notes, the notification body — may say Bubaly is calling or has called
// anyone. The words are "a parent books" / "a parent calls";
// tests/concierge-calls-honesty.test.ts pins the instantiated plan against
// the alternatives.
import { localTime, type TemplateContext, type WorkflowTemplate } from './index';

function issue(ctx: TemplateContext): string {
  return (ctx.entities.issue ?? ctx.requestText).trim().slice(0, 200) || 'Home repair';
}

function trade(ctx: TemplateContext): string {
  return (ctx.entities.trade ?? ctx.entities.vendor ?? issue(ctx)).trim().slice(0, 80);
}

export const findVendorTemplate: WorkflowTemplate = {
  intent: 'find_vendor',
  agent: 'household_manager',
  title: 'Find someone to fix it',
  deterministic: true,
  objective: (ctx) => `Get "${issue(ctx)}" fixed: find the right tradesperson on file and set up the repair.`,
  guidance: [
    'Prefer the contractor the family has used before for this trade (the service history in the context); mention their name and number in the task.',
    'If nobody is on file, the task asks a parent to choose a provider — never name a company or a number that is not in the context.',
    'Bubaly does not place phone calls. Never write that Bubaly is calling, will call or has called anyone; a parent makes the call from the task.',
    'Ask about severity only when it changes what happens today (water running, no heat, no power); otherwise plan without asking.',
    'When the request names a contractor to save, add a home.saveContractor step with their details.',
  ],
  steps: [
    { key: 'trade', stepType: 'retrieve', toolName: 'home.tradeFromIssue', description: 'Work out which trade this needs', input: (ctx) => ({ issue: issue(ctx) }) },
    { key: 'contractors', stepType: 'retrieve', toolName: 'home.listContractors', description: 'Check the tradespeople on file', input: (ctx) => ({ trade: trade(ctx) }) },
    { key: 'last_service', stepType: 'retrieve', toolName: 'home.lastServiceByTrade', description: 'See who did this kind of work last time', input: (ctx) => ({ trade: trade(ctx) }) },
    {
      key: 'maintenance_record', stepType: 'act', toolName: 'home.createMaintenanceTask', description: 'Open a home-maintenance record for the repair',
      dependsOn: ['trade'], input: (ctx) => ({ title: `Fix: ${issue(ctx)}`, description: ctx.requestText.slice(0, 500), priority: 'high', due_at: localTime(ctx.tomorrowKey, 17) }),
    },
    {
      key: 'contact_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Ask a parent to book the repair',
      dependsOn: ['contractors', 'last_service'],
      input: (ctx) => ({ title: `Book a repair: ${issue(ctx)}`, notes: 'A parent makes this call — Bubaly does not dial. Use the contractor on file if there is one; otherwise pick a provider.', due_date: ctx.tomorrowKey, priority: 'high' }),
    },
    {
      key: 'follow_up_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind a parent to confirm the appointment',
      dependsOn: ['contact_task'], input: (ctx) => ({ title: `Confirm the repair appointment: ${issue(ctx)}`, remind_at: localTime(ctx.dayAfterTomorrowKey, 9), kind: 'time', priority: 'high' }),
    },
    {
      key: 'tell_managers', stepType: 'notify', description: 'Tell the parents what is set up',
      dependsOn: ['maintenance_record', 'contact_task'],
      input: (ctx) => ({ recipients: 'managers', type: 'maintenance_task', title: `Repair set up: ${issue(ctx)}`, body: 'The maintenance record is open and a task to book the repair is waiting for a parent to make the call, with the contractor on file if there is one.' }),
    },
  ],
};
