import type { InsightKind } from '@/lib/ai/insights';
import { riskToDecision, type TrustRole } from '@/lib/trust/engine';

/**
 * The trust domain an insight READS, for the kinds whose data the assistant's
 * own read tools keep from some roles. `/api/ai/insights` refuses a kind when
 * the trust engine's view rule would refuse a read of its domain to the
 * caller's role — the rule `school.*`, `sports.*` and `trips.*` already answer
 * to. Without it a guest was refused `school.listClasses` and `trips.getTrip`
 * and then given a model summary of the same coaches, practice locations,
 * homework and trip destinations through that route instead. Not a
 * confidentiality boundary on its own — RLS still shows these rows in the app —
 * but one rule per role on every path the assistant answers through.
 *
 * `homework` and `timetable` read the same homework_assignments and
 * school_classes rows the `school` kind, `school.listHomeworkDue` and
 * `school.listClasses` do, and were missing — so a guest refused the school
 * summary was handed every child's open homework by the homework one.
 *
 * Its own module, as lib/ai/insight-features.ts is: the route and the screens
 * that offer the button (`mayAskInsight` in lib/ai/insights.ts) read ONE map.
 */
export const INSIGHT_READ_DOMAINS: Readonly<Partial<Record<InsightKind, string>>> = {
  school: 'education',
  sports: 'education',
  trips: 'travel',
  homework: 'homework',
  timetable: 'education',
};

const TRUST_ROLES: readonly string[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];

/**
 * Whether the trust engine's view rule refuses `role` a read of `kind`'s
 * domain. An unknown role is read as a guest's, as `roleOf`
 * (lib/trust/server.ts) reads it.
 */
export function insightReadRefused(kind: InsightKind, role: string | null | undefined): boolean {
  const domain = INSIGHT_READ_DOMAINS[kind];
  if (!domain) return false;
  const trustRole = (role && TRUST_ROLES.includes(role) ? role : 'guest') as TrustRole;
  return riskToDecision({
    risk: 'low', actor: { kind: 'member', id: 'viewer', role: trustRole },
    domain, capability: 'view', explicitAllow: false,
  }) !== null;
}
