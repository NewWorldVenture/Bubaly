// A notification that cannot be acted on is a notice, not a notification.
//
// The rows have carried `related_type` / `related_id` since 0002 and every
// generator writes them; nothing read them back, so tapping a notice only
// marked it read. These tests pin the two pure pieces that fix that: the
// mapper (row -> destination + optional inline action) and the classifier
// (type -> 'now' | 'digest').
//
// The load-bearing assertion is the first one: it walks the WHOLE
// `notification_type` catalogue rather than a hand-picked sample, so adding an
// enum member without giving it somewhere to go fails here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NOTIFICATION_LIST_HREF,
  NOTIFICATION_RELATED_TYPES,
  NOTIFICATION_TYPE_ROUTES,
  entityIdFrom,
  notificationAction,
  notificationHref,
} from '@/lib/notifications/actions';
import {
  DIGEST_NOTIFICATION_TYPES,
  isDigestNotification,
  notificationPriority,
  partitionByPriority,
} from '@/lib/notifications/priority';
import type { NotificationType } from '@/lib/database.types';

/**
 * The enum as the database declares it, read from the type file rather than
 * retyped here — a list copied into a test agrees with the schema exactly once,
 * on the day it is written.
 */
function catalogueFromSource(): NotificationType[] {
  const source = readFileSync('lib/database.types.ts', 'utf8');
  const start = source.indexOf('export type NotificationType =');
  expect(start).toBeGreaterThan(-1);
  const declaration = source.slice(start, source.indexOf(';', start));
  return [...declaration.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as NotificationType);
}

const CATALOGUE = catalogueFromSource();

describe('every notification type is actionable', () => {
  it('covers the whole notification_type catalogue', () => {
    // Ten members in 0002; if that changes, the rest of this file must be read
    // again rather than silently passing on a shorter list.
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(10);
    expect(CATALOGUE).toContain('chore_due');
    expect(Object.keys(NOTIFICATION_TYPE_ROUTES).sort()).toEqual([...CATALOGUE].sort());
  });

  it.each(CATALOGUE)('%s maps to a route', (type) => {
    const href = notificationHref({ type });
    expect(href.startsWith('/')).toBe(true);
    // No query strings: a `?focus=` no page reads is not a deep link.
    expect(href).not.toMatch(/[?#]/);
  });

  it('only the catch-all type falls back to the list itself', () => {
    const fallbacks = CATALOGUE.filter((type) => notificationAction({ type }).isFallback);
    expect(fallbacks).toEqual(['system']);
  });

  it('every related_type route is a real path too', () => {
    for (const related of NOTIFICATION_RELATED_TYPES) {
      const href = notificationHref({ type: 'system', related_type: related });
      expect(href.startsWith('/'), `${related} -> ${href}`).toBe(true);
      expect(href, `${related} must not fall back`).not.toBe(NOTIFICATION_LIST_HREF);
    }
  });
});

describe('related ids become deep links', () => {
  it('uses the id where the repo really has a per-id route', () => {
    const id = '3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
    expect(notificationHref({ type: 'system', related_type: 'marketplace_listings', related_id: id }))
      .toBe(`/marketplace/item/${id}`);
    // …and degrades to the listing page rather than `/marketplace/item/null`.
    expect(notificationHref({ type: 'system', related_type: 'marketplace_listings', related_id: null }))
      .toBe('/marketplace');
  });

  it('pulls the entity id out of the composite keys the generators write', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const member = '99999999-8888-7777-6666-555555555555';
    // approval reminders: `${approvalId}:${memberId}`; deadline reminders:
    // `${documentId}:${memberId}`; family reminders: `fr:${id}`.
    expect(entityIdFrom(`${id}:${member}`)).toBe(id);
    expect(entityIdFrom(`fr:${id}`)).toBe(id);
    expect(entityIdFrom(`${id}:2026`)).toBe(id);
    expect(entityIdFrom(id)).toBe(id);
  });

  it('refuses anything that is not an id', () => {
    // A composite key pasted into a URL as though it were an id would 404 at
    // best and address the wrong row at worst.
    expect(entityIdFrom('not-a-uuid')).toBeNull();
    expect(entityIdFrom('')).toBeNull();
    expect(entityIdFrom(null)).toBeNull();
    expect(entityIdFrom(undefined)).toBeNull();
  });

  it('prefers the related_type over the type when both are known', () => {
    // A `system` row about a calendar conflict belongs on the calendar, not on
    // the notifications list its type would suggest.
    expect(notificationHref({ type: 'system', related_type: 'calendar_events', related_id: 'x' }))
      .toBe('/dashboard/calendar');
  });

  it('falls back to the type when the related_type is unknown', () => {
    expect(notificationHref({ type: 'medication_due', related_type: 'something_new' }))
      .toBe('/dashboard/medications');
  });
});

describe('inline actions are offered only where an action exists', () => {
  const chore = '11111111-1111-1111-1111-111111111111';
  const approval = '22222222-2222-2222-2222-222222222222';

  it('offers chore sign-off for a chore_due row that names an assignment', () => {
    const action = notificationAction({ type: 'chore_due', related_type: 'chore_assignments', related_id: chore });
    expect(action.inline).toEqual({ kind: 'chore-signoff', assignmentId: chore });
    expect(action.href).toBe('/dashboard/chores');
  });

  it('offers an approval decision for an approval_requests row', () => {
    const action = notificationAction({ type: 'system', related_type: 'approval_requests', related_id: `${approval}:member` });
    expect(action.inline).toEqual({ kind: 'approval-decide', approvalId: approval });
    expect(action.href).toBe('/dashboard/trust');
  });

  it('offers nothing inline without a resolvable id', () => {
    // A button whose target cannot be resolved is an inert control.
    expect(notificationAction({ type: 'chore_due', related_type: 'chore_assignments', related_id: null }).inline).toBeNull();
    expect(notificationAction({ type: 'system', related_type: 'approval_requests', related_id: 'pending' }).inline).toBeNull();
  });

  it('offers nothing inline for any other kind', () => {
    // `parent_approvals` is the wallet's own table and is decided by the wallet
    // flow, not by `decideApproval` — so it links out instead of pretending.
    expect(notificationAction({ type: 'system', related_type: 'parent_approvals', related_id: `${approval}:m` }).inline).toBeNull();
    expect(notificationAction({ type: 'system', related_type: 'parent_approvals' }).href).toBe('/wallet');

    const others = CATALOGUE.filter((type) => type !== 'chore_due');
    for (const type of others) {
      expect(notificationAction({ type, related_type: 'chore_assignments', related_id: chore }).inline).toBeNull();
    }
  });

  it('never throws on a row that is missing everything', () => {
    expect(notificationAction(null)).toEqual({ href: NOTIFICATION_LIST_HREF, inline: null, isFallback: true });
    expect(notificationAction({})).toEqual({ href: NOTIFICATION_LIST_HREF, inline: null, isFallback: true });
  });
});

describe('priority', () => {
  it('classifies only the documented types as digest', () => {
    for (const type of DIGEST_NOTIFICATION_TYPES) expect(notificationPriority(type)).toBe('digest');
    const loud = CATALOGUE.filter((t) => !(DIGEST_NOTIFICATION_TYPES as readonly string[]).includes(t));
    for (const type of loud) expect(notificationPriority(type)).toBe('now');
  });

  it('keeps system loud, because approvals and conflicts ride on it', () => {
    // lib/notifications/approval-reminders.ts writes `type: 'system'`; burying
    // it would silence the very notice the family is being asked to answer.
    expect(notificationPriority('system')).toBe('now');
  });

  it('treats an unknown or missing type as loud rather than quiet', () => {
    expect(notificationPriority('a_type_added_next_year')).toBe('now');
    expect(notificationPriority(null)).toBe('now');
    expect(notificationPriority(undefined)).toBe('now');
    expect(isDigestNotification({})).toBe(false);
  });

  it('splits rows into exactly two groups, losing none', () => {
    const rows = [
      { id: 'a', type: 'chore_due' },
      { id: 'b', type: 'sports_event' },
      { id: 'c', type: 'system' },
      { id: 'd', type: 'grocery_reminder' },
    ];
    const { now, digest } = partitionByPriority(rows);
    expect(now.map((r) => r.id)).toEqual(['a', 'c']);
    expect(digest.map((r) => r.id)).toEqual(['b', 'd']);
    expect(now.length + digest.length).toBe(rows.length);
  });

  it('the bell counts the loud half and nothing else', () => {
    // Asserted on the source because the badge is a `head: true` count — there
    // are no rows to inspect after the await.
    const bell = readFileSync('components/app/notification-bell.tsx', 'utf8');
    expect(bell).toContain('DIGEST_NOTIFICATION_TYPES');
    expect(bell).toMatch(/\.not\('type', 'in',/);
  });
});

// There is no DOM harness in this suite, so the list is asserted the way
// tests/notification-due-surfaces.test.ts asserts the bell: on the source. The
// point is not the markup, it is that the mapper is WIRED — a mapper nothing
// calls leaves the product exactly where it was.
describe('the notifications list renders the mapping', () => {
  const source = readFileSync('components/modules/notifications-module.tsx', 'utf8');

  it('turns each row into its destination instead of only marking it read', () => {
    expect(source).toContain("from '@/lib/notifications/actions'");
    expect(source).toMatch(/notificationAction\(n\)/);
    expect(source).toMatch(/href=\{action\.href\}/);
  });

  it('acts through the existing server actions, never a direct write', () => {
    expect(source).toContain("from '@/app/(app)/dashboard/chores/actions'");
    expect(source).toContain("from '@/app/(app)/dashboard/approvals-actions'");
    expect(source).toMatch(/setChoreStatusAction\(action\.assignmentId, 'submitted'\)/);
    expect(source).toMatch(/decideApproval\(\{ id: action\.approvalId/);
  });

  it('reports the status the chore write settled on, not the one it asked for', () => {
    // `completeChoreAssignment` lands on 'done' only when the chore's
    // `requires_approval` is false, and that column is `not null default true`
    // (0002) — so the ordinary sign-off is written as 'submitted' and is still
    // waiting for a parent. A fixed "Chore marked done." toast would claim a
    // completion the row does not record; the chores board already branches on
    // the settled status, and so must this.
    const inline = source.slice(source.indexOf('async function runInline'), source.indexOf('const unread ='));
    const signoff = inline.slice(inline.indexOf("action.kind === 'chore-signoff'"), inline.indexOf('} else {'));
    expect(signoff).toMatch(/result\.status === 'done'/);
    expect(signoff).toContain('notificationActions.choreMarkedDone');
    expect(signoff).toContain('notificationActions.choreSubmittedForApproval');
    // …and never announces completion without consulting that status.
    expect(signoff).not.toMatch(/success\(\s*t\('notificationActions\.choreMarkedDone'\)\s*\)/);
    // Both halves of the branch are real copy, not a key that renders raw.
    const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    expect(en['notificationActions.choreMarkedDone']).toBeTruthy();
    expect(en['notificationActions.choreSubmittedForApproval']).toBeTruthy();
  });

  it('marks a row read only after the action succeeded', () => {
    // The failure branches return before `markRead`, so a chore that could not
    // be signed off stays unread and visible.
    const inline = source.slice(source.indexOf('async function runInline'));
    expect(inline.indexOf('if (!result.ok)')).toBeLessThan(inline.indexOf('await markRead(notificationId)'));
  });

  it('splits the list the same way the bell does', () => {
    expect(source).toContain("from '@/lib/notifications/priority'");
    expect(source).toMatch(/partitionByPriority\(data\)/);
    expect(source).toContain("t('notificationActions.alsoToday')");
  });

  it('gives every target 44px and a name that says which notification', () => {
    for (const cls of ['h-11 w-11', 'h-11 min-w-11', 'min-h-11']) {
      expect(source, `expected a ${cls} target`).toContain(cls);
    }
    for (const key of ['openNotification', 'markDoneAria', 'approveAria', 'declineAria', 'deleteAria']) {
      expect(source, `expected the accessible name ${key}`).toContain(`notificationActions.${key}`);
    }
    // Every accessible name carries the row's own title; "Approve" alone is
    // meaningless in a list of six.
    expect(source.match(/Aria', \{ title: n\.title \}\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('never renders a link back to the list it is already in', () => {
    expect(source).toMatch(/action\.isFallback \?/);
  });
});
