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

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  calling: 'Calling…',
  completed: 'Completed',
  failed: 'Failed',
  action_needed: 'Needs you',
  cancelled: 'Cancelled',
};

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
