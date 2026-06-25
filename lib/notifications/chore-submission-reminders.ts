import type { ManagerLite } from './deadline-reminders';

export interface SubmissionInput {
  id: string;
  assignment_id: string;
  member_id: string;
  status: string;
  chore_title: string;
  member_name: string;
}

export interface SubmissionReminder {
  type: 'system';
  related_type: 'chore_submissions';
  related_id: string;
  user_id: string | null;
  title: string;
  body: string;
}

export function choreSubmissionReminders(
  submissions: SubmissionInput[],
  managers: ManagerLite[],
): SubmissionReminder[] {
  const out: SubmissionReminder[] = [];
  const pending = submissions.filter((s) => s.status === 'pending');

  for (const s of pending) {
    if (managers.length === 0) {
      out.push({
        type: 'system',
        related_type: 'chore_submissions',
        related_id: s.id,
        user_id: null,
        title: `${s.member_name} submitted: ${s.chore_title}`,
        body: 'Awaiting review',
      });
    } else {
      for (const m of managers) {
        out.push({
          type: 'system',
          related_type: 'chore_submissions',
          related_id: `${s.id}:${m.id}`,
          user_id: m.user_id,
          title: `${s.member_name} submitted: ${s.chore_title}`,
          body: 'Awaiting review',
        });
      }
    }
  }
  return out;
}
