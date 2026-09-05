// Workflow A — Plan my meals (§18). Owner: the Meal Planner.
//
// Reads run in parallel (profile, busy evenings, pantry, budget, favourites),
// the plan is written in one call, and the list, prep task and reminder hang
// off it. The model fills the seven dinner entries; everything else is fixed.
import { localTime, shiftDay, type WorkflowTemplate } from './index';

export const planMealsTemplate: WorkflowTemplate = {
  intent: 'plan_meals',
  agent: 'meal_planner',
  title: 'Plan the week\'s meals',
  deterministic: false,
  objective: (ctx) => `Plan dinners for the week of ${ctx.weekStartKey} and get the shopping ready.`,
  guidance: [
    'Plan one dinner per day for the seven days starting on the week start; use quick meals on busy evenings and the family\'s favourites and food rules from the context.',
    'Never plan a dish that breaks an allergy or a "doesn\'t eat" fact on file.',
    'Keep the grocery step after the meal step; it reads the saved plan.',
    'Skip the budget read and the prep task only when the context shows the family has no budget or already has a prep routine.',
  ],
  steps: [
    { key: 'food_profile', stepType: 'retrieve', toolName: 'meals.foodProfile', description: 'Check everyone\'s food rules and favourites', input: () => ({}) },
    {
      key: 'busy_evenings', stepType: 'retrieve', toolName: 'calendar.busyEvenings', description: 'See which evenings are busy',
      input: (ctx) => ({ from: localTime(ctx.weekStartKey, 0), to: localTime(ctx.weekEndKey, 23, 59) }),
    },
    { key: 'pantry', stepType: 'retrieve', toolName: 'groceries.listOpen', description: 'See what is already on the shopping list', input: () => ({}) },
    { key: 'budget', stepType: 'retrieve', toolName: 'finances.budgetVsActual', description: 'Check the grocery budget for the month', input: (ctx) => ({ month: ctx.monthKey }), optional: true },
    { key: 'favourites', stepType: 'retrieve', toolName: 'meals.listRecipes', description: 'Pull the family\'s favourite recipes', input: () => ({ favorites_only: true, limit: 20 }) },
    {
      key: 'plan_dinners', stepType: 'act', toolName: 'meals.planWeek', description: 'Plan seven dinners around the week',
      dependsOn: ['food_profile', 'busy_evenings', 'pantry', 'budget', 'favourites'],
      input: () => ({ entries: [] }),
      modelFills: 'entries: one {date, meal_type:"dinner", meal_name, ingredients:[{name, quantity}]} per day of the week',
      verify: () => ({ checks: [{ kind: 'count_at_least', table: 'meal_plans', min: 5, label: 'At least five dinners are saved' }] }),
    },
    {
      key: 'grocery_list', stepType: 'act', toolName: 'groceries.addFromMealPlan', description: 'Add what the meals need to the shopping list',
      dependsOn: ['plan_dinners'], input: (ctx) => ({ week_start: ctx.weekStartKey }),
    },
    {
      key: 'prep_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Add a meal-prep task for the weekend before',
      dependsOn: ['plan_dinners'], input: (ctx) => ({ title: 'Meal prep for the week', due_date: shiftDay(ctx.weekStartKey, -1), priority: 'medium' }), optional: true,
    },
    {
      key: 'grocery_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind the family to shop before the week starts',
      dependsOn: ['grocery_list'], input: (ctx) => ({ title: 'Grocery run for this week\'s dinners', remind_at: localTime(shiftDay(ctx.weekStartKey, -1), 10), kind: 'time' }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Let the family know the week\'s dinners are set',
      dependsOn: ['grocery_list', 'grocery_reminder'],
      input: (ctx) => ({ recipients: 'family', type: 'grocery_reminder', title: 'This week\'s dinners are planned', body: `Dinners for the week of ${ctx.weekStartKey} are on the meal plan and the shopping list is ready.` }),
    },
  ],
};
