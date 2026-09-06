// What Bubaly can be asked to do about a suggestion, and what it cannot.
//
// §48 calls "[Let Bubaly handle it]" the signature moment: a family sees the
// thing that is wrong AND a way to have it dealt with, in the same place. Until
// now the button existed on exactly one screen — /dashboard/readiness — which is
// not where anyone lands. Everywhere else a suggestion was a link to the module
// that owns it, so the family left the page and redid by hand the thinking
// Bubaly had just done.
//
// THE MAP IS PARTIAL ON PURPOSE. A button that files a vague request is worse
// than no button: the planner gets nothing to work from, the run does nothing
// useful, and the family learns the button does not work. Worse, some of these
// are decisions a household must make itself, and offering to "handle" them
// would be Bubaly taking a call that is not its own. Both kinds are enumerated
// in NOT_HANDLED with the reason, so a new suggestion has to be classified
// rather than silently inheriting a button or silently missing one.
//
// The sentences are written the way a person would say them, because that is
// what the planner reads. "Get us ready" gives it nothing; "reschedule our
// overdue reminders" names a domain, an object and a verb.

/** Suggestion id → the request filed on the family's behalf. */
export const HANDLE_IT_REQUESTS: Readonly<Record<string, string>> = {
  'resolve-conflicts':
    'Two things are booked at the same time on our calendar. Work out what should move and reschedule it.',
  'clear-overdue-reminders':
    'Go through our overdue reminders and either reschedule each one for a sensible time or close it out.',
  'assign-events':
    'Some events this week have nobody responsible for them. Work out who should take each one and assign it.',
  'clear-overdue-tasks':
    'Our tasks and chores are overdue. Reschedule them across the next few days so they are actually doable.',
  'restock':
    'We are low on things at home. Add what we need to the grocery list.',
  'renew-docs':
    'Some of our documents expire soon. Set a reminder for each one, early enough to actually renew it.',
  'rebalance-load':
    'One person is carrying much more of this week than everyone else. Suggest a fairer split and move what you can.',
};

/**
 * Suggestions that deliberately get no button, and why. Two kinds:
 * a DECISION the household owns, or an ACTION Bubaly must not initiate.
 */
export const NOT_HANDLED: Readonly<Record<string, string>> = {
  'fix-negative-balances':
    'moving money to cover an overdrawn account is a transfer, and Bubaly does not move money on its own',
  'cover-bills':
    'same — covering a bill is a payment, and the family decides which account it comes from',
  'decide-approvals':
    'the pending item IS a decision waiting for a person; offering to handle it would have Bubaly approve its own requests',
  'close-votes':
    'a family vote is the household making up its mind, not a task to be closed out',
  'nudge-goals':
    'a stalled savings goal is a conversation between the people saving, not something to automate a nudge for',
};

/** The request to file for `id`, or null when this is not Bubaly's to handle. */
export function handleItRequest(id: string): string | null {
  return HANDLE_IT_REQUESTS[id] ?? null;
}
