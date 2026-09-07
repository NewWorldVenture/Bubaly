// lib/concierge-calls/brief.ts — pure, unit-tested AI call-brief builder + labels.
//
// Turns a call request (task + callee + goal + constraints) into the structured
// plan the AI follows on the phone: a natural opening line, ordered talking
// points, the questions it must get answered, the success criteria, and a
// fallback if the goal can't be met. Framework/DB-free so the server action, the
// telephony route, and the review UI all share one source of truth and it can be
// tested without a phone provider or an LLM. An LLM can later refine `brief`, but
// this deterministic version is always a safe, complete floor.

export type CallTaskKind = 'book' | 'reschedule' | 'cancel' | 'confirm' | 'inquire' | 'follow_up' | 'other';
export type CallStatus = 'draft' | 'queued' | 'calling' | 'completed' | 'failed' | 'action_needed' | 'cancelled';
export type CallCategory = 'medical' | 'dental' | 'school' | 'restaurant' | 'service' | 'utility' | 'retail' | 'government' | 'other';

export interface CallRequest {
  taskKind: CallTaskKind;
  calleeName: string;
  goal: string;
  /** Optional structured constraints (all free-form, all optional). */
  details?: {
    familyName?: string;
    memberName?: string;      // who the call is about ("for Emma")
    preferredTimes?: string;  // "weekday mornings", "after 3pm"
    referenceNumber?: string; // booking / account / confirmation #
    budget?: string;
    phone?: string;
    notes?: string;
  };
}

export interface CallBrief {
  opening: string;
  keyPoints: string[];
  questions: string[];
  successCriteria: string;
  fallback: string;
}

export const CALL_TASK_LABEL: Record<CallTaskKind, string> = {
  book: 'Book an appointment',
  reschedule: 'Reschedule',
  cancel: 'Cancel',
  confirm: 'Confirm',
  inquire: 'Ask a question',
  follow_up: 'Follow up',
  other: 'Other',
};

/** Catalogue keys for `CALL_TASK_LABEL`, so a client renders `t(key)` and the English above stays the fallback. */
export const CALL_TASK_LABEL_KEY: Record<CallTaskKind, string> = {
  book: 'conciergeCalls.taskBook',
  reschedule: 'conciergeCalls.taskReschedule',
  cancel: 'conciergeCalls.taskCancel',
  confirm: 'conciergeCalls.taskConfirm',
  inquire: 'conciergeCalls.taskInquire',
  follow_up: 'conciergeCalls.taskFollowUp',
  other: 'conciergeCalls.taskOther',
};

export const CALL_CATEGORY_LABEL: Record<CallCategory, string> = {
  medical: 'Medical', dental: 'Dental', school: 'School', restaurant: 'Restaurant', service: 'Service',
  utility: 'Utility', retail: 'Retail', government: 'Government', other: 'Other',
};

export const CALL_CATEGORY_LABEL_KEY: Record<CallCategory, string> = {
  medical: 'conciergeCalls.categoryMedical',
  dental: 'conciergeCalls.categoryDental',
  school: 'conciergeCalls.categorySchool',
  restaurant: 'conciergeCalls.categoryRestaurant',
  service: 'conciergeCalls.categoryService',
  utility: 'conciergeCalls.categoryUtility',
  retail: 'conciergeCalls.categoryRetail',
  government: 'conciergeCalls.categoryGovernment',
  other: 'conciergeCalls.categoryOther',
};

/**
 * The STORAGE vocabulary — one label per `concierge_calls.status` value, for
 * logs, exports and tests that talk about rows. It is NOT what a family sees:
 * `status = 'calling'` is a row the queue picked up, and on its own it proves
 * nothing about a phone ringing. The UI renders `callDisplayState()` below,
 * which says "Calling…" or "Called" only once a provider has written
 * `provider_ref` onto the row.
 */
export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  calling: 'Calling…',
  completed: 'Completed',
  failed: 'Failed',
  action_needed: 'Needs you',
  cancelled: 'Cancelled',
};

// ── honest display state ─────────────────────────────────────────────────────
//
// What a family may be told about a call is bounded by what is persisted on the
// row. Bubaly has no outbound voice integration today: the placement cron
// (`app/api/concierge-calls/place`) never dials, so nothing writes
// `provider_ref`, and the only way a row reaches 'completed' is a parent
// logging what happened after making the call themselves. The display state
// therefore derives from TWO columns — `status` and `provider_ref` — and the
// words "Calling…" / "Called" are unreachable while `provider_ref` is null.
// `tests/concierge-calls-honesty.test.ts` pins that.

export type CallDisplayState =
  | 'draft'         // no phone number yet; nothing can happen until a person adds one
  | 'queued'        // waiting in the queue (status queued, or 'calling' with no provider confirmation)
  | 'calling'       // a provider has confirmed the call is in progress (provider_ref set)
  | 'called'        // a provider has confirmed the call happened (provider_ref set)
  | 'logged'        // a parent made the call and logged the result by hand
  | 'failed'        // the attempt failed
  | 'needs_person'  // parked: no phone provider, so a person places this call
  | 'needs_you'     // a provider ran the call and something needs the family
  | 'cancelled';

/** The columns the display state is allowed to read. */
export type CallRowState = { status: string; provider_ref: string | null };

/** True only when a telephony provider has written its call/session id onto the row. */
export function providerConfirmed(row: CallRowState): boolean {
  return typeof row.provider_ref === 'string' && row.provider_ref.trim().length > 0;
}

/** What the family may be told about this row, from persisted columns only. */
export function callDisplayState(row: CallRowState): CallDisplayState {
  const confirmed = providerConfirmed(row);
  switch (row.status) {
    case 'draft': return 'draft';
    case 'queued': return 'queued';
    case 'calling': return confirmed ? 'calling' : 'queued';
    case 'completed': return confirmed ? 'called' : 'logged';
    case 'failed': return 'failed';
    case 'action_needed': return confirmed ? 'needs_you' : 'needs_person';
    case 'cancelled': return 'cancelled';
    default: return 'queued';
  }
}

/** English label plus the catalogue key a client renders it through. */
export const CALL_DISPLAY_LABEL: Record<CallDisplayState, { label: string; labelKey: string }> = {
  draft: { label: 'Draft', labelKey: 'conciergeCalls.stateDraft' },
  queued: { label: 'Queued for a call', labelKey: 'conciergeCalls.stateQueued' },
  calling: { label: 'Calling…', labelKey: 'conciergeCalls.stateCalling' },
  called: { label: 'Called', labelKey: 'conciergeCalls.stateCalled' },
  logged: { label: 'Done — logged by hand', labelKey: 'conciergeCalls.stateLogged' },
  failed: { label: 'Failed', labelKey: 'conciergeCalls.stateFailed' },
  needs_person: { label: 'Waiting for a person to call', labelKey: 'conciergeCalls.stateNeedsPerson' },
  needs_you: { label: 'Needs you', labelKey: 'conciergeCalls.stateNeedsYou' },
  cancelled: { label: 'Cancelled', labelKey: 'conciergeCalls.stateCancelled' },
};

/** UI tone per display state. */
export function callDisplayTone(state: CallDisplayState): 'neutral' | 'info' | 'success' | 'danger' | 'warn' {
  switch (state) {
    case 'called': case 'logged': return 'success';
    case 'calling': case 'queued': return 'info';
    case 'failed': return 'danger';
    case 'needs_person': case 'needs_you': return 'warn';
    default: return 'neutral';
  }
}

/** States a person can still act on by making the call and logging what happened. */
export function canLogOutcome(state: CallDisplayState): boolean {
  return state === 'draft' || state === 'queued' || state === 'needs_person' || state === 'failed';
}

/**
 * The outcome the placement cron persists when it parks a queued call. Written
 * to `concierge_calls.outcome` — the only free-text column — so the row itself
 * says why nobody automated is going to place it.
 */
export const NO_PROVIDER_OUTCOME = 'No phone provider connected — a parent places this call.';

/** UI tone per status (neutral tailwind-ish keys the component maps to classes). */
export function callStatusTone(status: CallStatus): 'neutral' | 'info' | 'success' | 'danger' | 'warn' {
  switch (status) {
    case 'completed': return 'success';
    case 'calling': case 'queued': return 'info';
    case 'failed': return 'danger';
    case 'action_needed': return 'warn';
    default: return 'neutral';
  }
}

const VERB: Record<CallTaskKind, string> = {
  book: 'book', reschedule: 'reschedule', cancel: 'cancel',
  confirm: 'confirm', inquire: 'ask about', follow_up: 'follow up on', other: 'help with',
};

/**
 * Build the deterministic call brief. Never throws; missing details just yield a
 * shorter (still valid) plan.
 */
export function buildCallBrief(req: CallRequest): CallBrief {
  const d = req.details ?? {};
  const who = d.memberName ? ` for ${d.memberName}` : '';
  const onBehalf = d.familyName ? `the ${d.familyName} family` : 'a family';
  const verb = VERB[req.taskKind] ?? 'help with';

  const opening =
    `Hi, I'm an assistant calling on behalf of ${onBehalf}. ` +
    `I'd like to ${verb}${who ? who : ''} — ${req.goal.trim().replace(/\.$/, '')}.`;

  const keyPoints: string[] = [];
  keyPoints.push(`Goal: ${req.goal.trim()}`);
  if (d.memberName) keyPoints.push(`This is regarding ${d.memberName}.`);
  if (d.referenceNumber) keyPoints.push(`Reference / account number: ${d.referenceNumber}.`);
  if (d.preferredTimes) keyPoints.push(`Preferred times: ${d.preferredTimes}.`);
  if (d.budget) keyPoints.push(`Budget: ${d.budget}.`);
  if (d.notes) keyPoints.push(`Note: ${d.notes}`);
  keyPoints.push('Be polite and concise; do not share sensitive info beyond what is needed.');

  const questions: string[] = [];
  switch (req.taskKind) {
    case 'book':
      questions.push('What is the earliest available slot that fits the preferred times?');
      questions.push('What do we need to bring or prepare?');
      questions.push('Can I get a confirmation number?');
      break;
    case 'reschedule':
      questions.push('What new times are available?');
      questions.push('Is there any rescheduling fee?');
      questions.push('Can I get a new confirmation number?');
      break;
    case 'cancel':
      questions.push('Is the cancellation confirmed with no penalty?');
      questions.push('Can I get a cancellation reference?');
      break;
    case 'confirm':
      questions.push('Is the appointment/reservation still confirmed for the expected date and time?');
      questions.push('Is there anything we need to do beforehand?');
      break;
    case 'follow_up':
      questions.push('What is the current status?');
      questions.push('What are the next steps and expected timing?');
      break;
    default:
      questions.push('What are the available options?');
      questions.push('What are the next steps?');
  }

  const successCriteria =
    req.taskKind === 'inquire' || req.taskKind === 'follow_up'
      ? 'Get a clear, specific answer to the goal and note any next steps.'
      : `The ${req.taskKind === 'book' ? 'booking' : req.taskKind} is done and a confirmation reference is captured.`;

  const fallback =
    "If the goal can't be completed on this call (no availability, needs the account holder, " +
    'or asks for a decision outside the given constraints), politely take down options/next steps, ' +
    'do NOT commit to anything unapproved, and mark the request as needing the family.';

  return { opening, keyPoints, questions, successCriteria, fallback };
}

/** One-line human summary for list rows / notifications. */
export function callSummary(req: Pick<CallRequest, 'taskKind' | 'calleeName' | 'goal'>): string {
  return `${CALL_TASK_LABEL[req.taskKind]} · ${req.calleeName}`;
}
