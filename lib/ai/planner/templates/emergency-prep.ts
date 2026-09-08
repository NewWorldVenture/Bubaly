// Workflow — Emergency preparedness (M25). Owner: the Household Manager.
//
// This is the one workflow whose value is entirely in the boring half: the
// household that has a kit but no current insurance document, or a meeting
// point nobody has been told, is not prepared. So the reads come first and the
// plan is built from what the household is actually MISSING — never a generic
// list of things a well-prepared family owns.
//
// It is `deterministic: false` on purpose: the tasks it writes have to name the
// gaps the reads found, and a routine that fired this without a model would
// write "check the emergency kit" every month forever.
import { localTime, shiftDay, type WorkflowTemplate } from './index';

/** How far out the readiness work is scheduled — near enough to matter, far enough to be doable. */
const HORIZON_DAYS = 14;

export const emergencyPrepTemplate: WorkflowTemplate = {
  intent: 'emergency_prep',
  agent: 'household_manager',
  title: 'Get the household ready for an emergency',
  deterministic: false,
  objective: () => 'Close the gaps in the household\'s emergency readiness: documents in date, a stocked kit, a plan everyone has actually been told.',
  guidance: [
    'Build every act step from the gaps the reads found. A document the context shows as current does not get a renewal task; a supply already on the list does not get added again.',
    'One task per gap, keyed gap_task, gap_task_2 and so on, each naming the specific thing that is missing and who owns it.',
    'The kit supplies go on the shopping list in ONE groceries.addItems step.',
    'The notification is the plan itself: where the family meets, who is called first, where the documents live. It is the step that turns preparation into readiness, so never drop it.',
    'Never claim the household is prepared. Say what is now in place and what is still open.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm who is in the household', input: () => ({}) },
    { key: 'documents', stepType: 'retrieve', toolName: 'documents.expiringBefore', description: 'Find documents that are expired or expiring', input: () => ({ within_days: 180 }) },
    { key: 'insurance', stepType: 'retrieve', toolName: 'documents.listDocuments', description: 'Check the insurance and identity documents on file', input: () => ({ category: 'insurance', limit: 30 }) },
    { key: 'home_tasks', stepType: 'retrieve', toolName: 'home.listOpenMaintenance', description: 'Read the safety maintenance still open', input: () => ({}) },
    { key: 'grocery', stepType: 'retrieve', toolName: 'groceries.listOpen', description: 'Read what is already on the shopping list', input: () => ({ limit: 50 }) },
    { key: 'contacts', stepType: 'retrieve', toolName: 'memory.recall', description: 'Recall the emergency contacts the family has told Bubaly', input: () => ({ category: 'contact', limit: 20 }) },
    {
      key: 'kit_supplies', stepType: 'act', toolName: 'groceries.addItems', description: 'Put the missing kit supplies on the shopping list',
      dependsOn: ['grocery', 'members'],
      input: () => ({ items: [] }),
      modelFills: 'items: only the kit supplies the context does not already show — water, batteries, medication, pet food, sized to this household',
    },
    {
      key: 'gap_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Close the readiness gap that matters most',
      dependsOn: ['documents', 'insurance', 'home_tasks', 'contacts'],
      input: (ctx) => ({ title: '', due_date: shiftDay(ctx.todayKey, HORIZON_DAYS), priority: 'high' }),
      modelFills: 'title naming the specific gap the reads found, with an adult as assignee',
    },
    {
      key: 'safety_check', stepType: 'act', toolName: 'home.createMaintenanceTask', description: 'Book the safety check the home is missing',
      dependsOn: ['home_tasks'],
      input: (ctx) => ({ title: 'Test smoke and carbon-monoxide alarms', due_at: localTime(shiftDay(ctx.todayKey, 7), 10), priority: 'high', interval_days: 180 }),
      optional: true,
    },
    {
      key: 'review_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Set the six-month readiness review',
      dependsOn: ['gap_task'],
      input: (ctx) => ({ title: 'Review the emergency plan: documents, kit, contacts, meeting point', remind_at: localTime(shiftDay(ctx.todayKey, 182), 10), kind: 'time', priority: 'medium' }),
    },
    {
      key: 'check_gaps', stepType: 'verify', description: 'Check the readiness work really landed',
      dependsOn: ['gap_task', 'review_reminder'],
      input: () => ({
        checks: [
          { kind: 'records_exist', table: 'todo_items', ids: [{ $fromStep: 'gap_task', path: 'id' }], label: 'The gap is on someone\'s list' },
          { kind: 'records_exist', table: 'family_reminders', ids: [{ $fromStep: 'review_reminder', path: 'id' }], label: 'The readiness review is scheduled' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Tell the household the plan and what is still open',
      dependsOn: ['check_gaps', 'kit_supplies', 'safety_check'],
      input: () => ({ recipients: 'family', type: 'system', title: 'The emergency plan', body: '' }),
      modelFills: 'body: where the family meets, who to call, where the documents are, and the gaps that are still open',
    },
  ],
};
