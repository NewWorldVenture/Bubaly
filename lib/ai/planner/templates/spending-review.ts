// Workflow B — Why did we spend too much? (§18). Owner: the Budget Coach.
//
// Fully deterministic: six read-only analyses over the month under review,
// then one note to the managers that the review is ready. The model may add
// the actions the spec lists (revise a budget, set a savings target, a task to
// review discretionary spend), each of which the trust engine gates on its
// own — a budget change is high risk and always waits for a person.
import { type WorkflowTemplate } from './index';

export const spendingReviewTemplate: WorkflowTemplate = {
  intent: 'spending_review',
  agent: 'budget_coach',
  title: 'Review this month\'s spending',
  deterministic: true,
  objective: (ctx) => `Explain where ${ctx.monthKey}'s spending went against plan and what would bring it back.`,
  guidance: [
    'Every number in the summary must come from the context or the retrieve steps; never estimate a figure.',
    'Name the three biggest drivers with their amounts, then offer actions: revise the remaining budget (finances.updateBudget), a savings target (finances.createSavingsGoal), a task to review discretionary expenses (tasks.createTodo), or a change to next week\'s meals (meals.planWeek). Add only the actions the numbers justify.',
    'A budget change always waits for a person; say so in the reasoning summary rather than promising it.',
  ],
  steps: [
    { key: 'budget_vs_actual', stepType: 'retrieve', toolName: 'finances.budgetVsActual', description: 'Compare each budget with what was spent', input: (ctx) => ({ month: ctx.monthKey }) },
    { key: 'by_category', stepType: 'retrieve', toolName: 'finances.spendingByCategory', description: 'Total spending by category', input: (ctx) => ({ from: ctx.monthStartKey, to: ctx.monthEndKey }) },
    { key: 'previous_period', stepType: 'retrieve', toolName: 'finances.comparePeriods', description: 'Compare with last month', input: (ctx) => ({ from: ctx.monthStartKey, to: ctx.monthEndKey, compare_from: ctx.previousMonthStartKey, compare_to: ctx.previousMonthEndKey }) },
    { key: 'merchants', stepType: 'retrieve', toolName: 'finances.merchantMovement', description: 'See which merchants moved', input: (ctx) => ({ from: ctx.monthStartKey, to: ctx.monthEndKey, limit: 15 }) },
    { key: 'recurring', stepType: 'retrieve', toolName: 'finances.recurringChanges', description: 'Check recurring charges that changed', input: () => ({ months: 3 }) },
    { key: 'unusual', stepType: 'retrieve', toolName: 'finances.unusualTransactions', description: 'Flag unusual transactions', input: (ctx) => ({ from: ctx.monthStartKey, to: ctx.monthEndKey }) },
    {
      key: 'tell_managers', stepType: 'notify', description: 'Let the parents know the review is ready',
      dependsOn: ['budget_vs_actual', 'by_category', 'previous_period', 'merchants', 'recurring', 'unusual'],
      input: (ctx) => ({ recipients: 'managers', type: 'system', title: `Spending review for ${ctx.monthKey} is ready`, body: 'Bubaly compared the month with plan and with last month. Open the run to see the biggest drivers and the options.' }),
    },
  ],
};
