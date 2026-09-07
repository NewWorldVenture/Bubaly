// What a notification actually lets you DO.
//
// The rows have carried `related_type` and `related_id` since 0002 — every
// generator writes them (`lib/server/notifications.ts`, the deadline,
// medication and approval reminder builders, `lib/autopilot/scan.ts`, the
// marketplace and wallet crons) — and until now nothing read them back. Tapping
// a notice marked it read. That is the whole interaction: a family is told
// "Chore due: bins" and then has to go and find the bins chore themselves.
//
// This is the pure mapping from a row to a destination, and where one exists,
// to an action that can be taken without leaving the list. Pure so that the
// list, the bell and the brief cannot drift into three different answers, and
// so a test can walk the entire `notification_type` catalogue and assert that
// none of them is a dead end.
//
// TWO RULES KEPT THROUGHOUT:
//
//  1. A destination is a route that exists. Nothing here invents a query
//     parameter no page reads: `/dashboard/chores` is honest, and
//     `/dashboard/chores?focus=<id>` — which every page would ignore — is
//     theatre. Where the repo really does have a per-id route
//     (`/marketplace/item/[id]`) the id is used.
//  2. An inline action is only offered where an existing server action can
//     genuinely complete it: chore sign-off (`setChoreStatusAction`) and an
//     approval decision (`decideApproval`). Everything else links out rather
//     than growing a button that half-works.
import type { NotificationType } from '@/lib/database.types';

/** The list itself: the honest destination for a notice with nowhere better to go. */
export const NOTIFICATION_LIST_HREF = '/dashboard/notifications';

export type NotificationInlineAction =
  /** `chore_assignments.id` — `setChoreStatusAction(id, 'submitted')`. */
  | { kind: 'chore-signoff'; assignmentId: string }
  /** `approval_requests.id` — `decideApproval({ id, decision })`. */
  | { kind: 'approval-decide'; approvalId: string };

export type NotificationTarget = {
  /** Always a real route. Never null, so no row is a dead end. */
  href: string;
  /** Present only where an existing action can finish the job from the row. */
  inline: NotificationInlineAction | null;
  /**
   * True when `href` is the notifications list itself — i.e. the row named no
   * destination we can honour. Surfaces use it to render plain text instead of
   * a link that goes nowhere.
   */
  isFallback: boolean;
};

export type NotificationRowLike = {
  type?: NotificationType | string | null;
  related_type?: string | null;
  related_id?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The entity id inside a `related_id`.
 *
 * Several generators make the value unique per recipient or per occurrence so
 * the dedupe key stays distinct: `${approvalId}:${memberId}` (approval
 * reminders), `${documentId}:${memberId}` (deadline reminders),
 * `${dateId}:${year}` (relationship dates), `fr:${id}` (family reminders).
 * Only a segment that really looks like a uuid is treated as an id — a
 * composite key must never be pasted into a URL as though it were one.
 */
export function entityIdFrom(relatedId: string | null | undefined): string | null {
  if (typeof relatedId !== 'string') return null;
  for (const part of relatedId.split(':')) if (UUID.test(part)) return part;
  return null;
}

/**
 * `related_type` → route. The keys are the values actually written in this
 * repo; a value not listed here falls through to the type map below, and a type
 * that is not listed there falls through to the list itself.
 */
const RELATED_ROUTES: Record<string, (id: string | null) => string> = {
  allowance_rules: () => '/wallet',
  approval_requests: () => '/dashboard/trust',
  autopilot_suggestions: () => '/dashboard/autopilot',
  calendar_event: () => '/dashboard/calendar',
  calendar_events: () => '/dashboard/calendar',
  chore_assignments: () => '/dashboard/chores',
  contact_center: () => '/dashboard/contact-center',
  documents: () => '/dashboard/documents',
  family: () => '/dashboard/family',
  family_photos: () => '/dashboard/photos',
  family_reminders: () => '/dashboard/reminders',
  feedback_idea: () => '/feedback',
  gift_payments: () => '/wallet',
  guardian_communications: () => '/guardian/history',
  location_events: () => '/dashboard/locator',
  marketplace_listings: (id) => (id ? `/marketplace/item/${id}` : '/marketplace'),
  marketplace_orders: () => '/marketplace/orders',
  marketplace_report: () => '/marketplace',
  medications: () => '/dashboard/medications',
  opportunities: () => '/dashboard/next-best-actions',
  parent_approvals: () => '/wallet',
  relationship_dates: () => '/dashboard/relationship',
  reminders: () => '/dashboard/reminders',
  renewals: () => '/dashboard/renewals',
  school_events: () => '/dashboard/school',
  social: () => '/dashboard/social',
  sports_events: () => '/dashboard/sports',
  spend_request: () => '/wallet',
  subscription: () => '/dashboard/billing',
};

/**
 * Every member of `public.notification_type` (lib/database.types.ts:51). The
 * `Record` is exhaustive by construction: adding an enum member without a route
 * stops the build, which is the point — a new notification type must not
 * quietly become unactionable.
 */
const TYPE_ROUTES: Record<NotificationType, string> = {
  chore_due: '/dashboard/chores',
  medication_due: '/dashboard/medications',
  calendar_event: '/dashboard/calendar',
  school_event: '/dashboard/school',
  sports_event: '/dashboard/sports',
  // Home maintenance lives on the home module, not a route of its own.
  maintenance_task: '/dashboard/home',
  grocery_reminder: '/dashboard/grocery',
  document_expiry: '/dashboard/documents',
  family_invite: '/dashboard/family',
  // The catch-all. Almost every `system` row carries a `related_type` that
  // resolves above; the ones that do not (an admin sync notice, a support
  // ticket) have nothing better than the list they are already in.
  system: NOTIFICATION_LIST_HREF,
};

/** Where a notification should take you. Never empty. */
export function notificationHref(row: NotificationRowLike | null | undefined): string {
  const related = row?.related_type ? RELATED_ROUTES[row.related_type] : undefined;
  if (related) return related(entityIdFrom(row?.related_id));
  const type = row?.type;
  if (typeof type === 'string' && type in TYPE_ROUTES) return TYPE_ROUTES[type as NotificationType];
  return NOTIFICATION_LIST_HREF;
}

/**
 * The inline action, if this row is one of the two kinds that can be finished
 * from the list.
 *
 * Both need a real uuid: without one there is nothing to act on, and offering a
 * button that cannot resolve its target is exactly the inert control this
 * product is not allowed to render.
 */
function inlineActionFor(row: NotificationRowLike): NotificationInlineAction | null {
  const id = entityIdFrom(row.related_id);
  if (!id) return null;
  if (row.type === 'chore_due' && row.related_type === 'chore_assignments') {
    return { kind: 'chore-signoff', assignmentId: id };
  }
  if (row.related_type === 'approval_requests') {
    return { kind: 'approval-decide', approvalId: id };
  }
  return null;
}

/** The whole answer for one row: where it goes, and what it can do in place. */
export function notificationAction(row: NotificationRowLike | null | undefined): NotificationTarget {
  const safe: NotificationRowLike = row ?? {};
  const href = notificationHref(safe);
  return {
    href,
    inline: inlineActionFor(safe),
    isFallback: href === NOTIFICATION_LIST_HREF,
  };
}

/** Exported for the test that walks the catalogue; not used at runtime. */
export const NOTIFICATION_TYPE_ROUTES: Readonly<Record<NotificationType, string>> = TYPE_ROUTES;
/** Exported for the test that pins the `related_type` vocabulary. */
export const NOTIFICATION_RELATED_TYPES: readonly string[] = Object.keys(RELATED_ROUTES);
