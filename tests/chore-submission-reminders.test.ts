import { describe, expect, it } from 'vitest';
import { choreSubmissionReminders, type SubmissionInput } from '@/lib/notifications/chore-submission-reminders';
import type { ManagerLite } from '@/lib/notifications/deadline-reminders';

const MANAGERS: ManagerLite[] = [
  { id: 'm1', user_id: 'u1' },
  { id: 'm2', user_id: 'u2' },
];

describe('choreSubmissionReminders', () => {
  it('generates one notification per manager for pending submissions', () => {
    const subs: SubmissionInput[] = [
      { id: 's1', assignment_id: 'a1', member_id: 'kid1', status: 'pending', chore_title: 'Take out trash', member_name: 'Emma' },
    ];
    const result = choreSubmissionReminders(subs, MANAGERS);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Emma submitted: Take out trash');
    expect(result[0].body).toBe('Awaiting review');
    expect(result[0].user_id).toBe('u1');
    expect(result[1].user_id).toBe('u2');
    expect(result[0].related_type).toBe('chore_submissions');
  });

  it('skips non-pending submissions', () => {
    const subs: SubmissionInput[] = [
      { id: 's1', assignment_id: 'a1', member_id: 'kid1', status: 'approved', chore_title: 'Dishes', member_name: 'Mia' },
      { id: 's2', assignment_id: 'a2', member_id: 'kid1', status: 'rejected', chore_title: 'Laundry', member_name: 'Mia' },
    ];
    expect(choreSubmissionReminders(subs, MANAGERS)).toHaveLength(0);
  });

  it('broadcasts when no managers exist', () => {
    const subs: SubmissionInput[] = [
      { id: 's1', assignment_id: 'a1', member_id: 'kid1', status: 'pending', chore_title: 'Vacuum', member_name: 'Jack' },
    ];
    const result = choreSubmissionReminders(subs, []);
    expect(result).toHaveLength(1);
    expect(result[0].user_id).toBeNull();
  });

  it('handles multiple pending submissions', () => {
    const subs: SubmissionInput[] = [
      { id: 's1', assignment_id: 'a1', member_id: 'kid1', status: 'pending', chore_title: 'Trash', member_name: 'Emma' },
      { id: 's2', assignment_id: 'a2', member_id: 'kid2', status: 'pending', chore_title: 'Dishes', member_name: 'Jack' },
    ];
    const result = choreSubmissionReminders(subs, MANAGERS);
    expect(result).toHaveLength(4);
  });
});
