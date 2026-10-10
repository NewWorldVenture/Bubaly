import { describe, expect, it } from 'vitest';
import { managerOnlyText } from '@/lib/ai/context/slices/proactive';

/**
 * A CHILD'S CONTEXT WITHHOLDS EVERY FORM OF A MONEY WORD (AI-001).
 *
 * The proactive slice is the one household-wide slice every member's prompt
 * carries. Its reasoning report, signals, autopilot suggestions and
 * recommendations can mention budgets, bills or documents, which are
 * manager-only (§4, SLICE_ACCESS), so for anyone else an item that touches
 * them is dropped by a word filter.
 *
 * The filter matched whole words in the SINGULAR only, and one stem that can
 * never be a whole word: `\bfinanc\b` does not match "finance" or
 * "financial", because there is no word boundary inside a word. So "2
 * documents expire this month", "3 unusual transactions" and "Financial goal:
 * $1,200 of $5,000" reached a child's prompt, and Bubaly could repeat them.
 */
describe('what a manager-only item may be worded as', () => {
  it.each([
    'Financial goal: emergency fund at $1,200 of $5,000',
    'Review the family finances this weekend',
    '2 documents expire this month',
    '3 unusual transactions this week',
    'Passports expire before the trip',
    'Two subscriptions renew Friday',
    'File taxes by April',
    'Check the bank accounts',
    'You spent $40 more on takeout',
    'Spending is up 12% on groceries',
    'Budgets drifted in two categories',
    'Salaries land on the 1st',
    'Car insurance renews in 5 days',
    'The mortgage payment is due',
    'Loan payment scheduled',
    'Investments rebalanced',
    'Electric bill due Friday',
  ])('withholds %j from a child', (text) => {
    expect(managerOnlyText(text)).toBe(true);
  });

  it.each([
    'Soccer practice moved to 5pm',
    'Taxi to the airport at 6',
    'Homework due tomorrow',
    'Grocery list is empty',
    'Sam has three chores overdue',
    'Banksy exhibit on Saturday',
  ])('keeps %j for everyone', (text) => {
    expect(managerOnlyText(text)).toBe(false);
  });

  it('reads every part it is given, and nothing that is absent', () => {
    expect(managerOnlyText('Weekly check-in', null, undefined, '/dashboard/finances')).toBe(true);
    expect(managerOnlyText(null, undefined)).toBe(false);
  });
});
