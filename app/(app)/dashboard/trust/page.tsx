import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { scopeFromUserContext } from '@/lib/services/scope';
import { loadApprovalBasedOn, loadTrustActivity, type BasedOn } from '@/lib/trust/activity';
import { TrustModule, type TrustData } from '@/components/modules/trust-module';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Trust & Permissions' };
export const dynamic = 'force-dynamic';

export default async function TrustPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'trust', '/dashboard/trust');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const nowIso = new Date().toISOString();
  const scope = scopeFromUserContext(ctx, supabase);

  const [
    membersRes,
    policiesRes,
    grantsRes,
    delegationsRes,
    approvalsRes,
    emergenciesRes,
    { data: audit },
    activityRes,
  ] = await Promise.all([
    supabase.from('family_members').select('id, display_name, role, color').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('trust_policies').select('*').eq('family_id', familyId).order('priority', { ascending: false }),
    supabase.from('permission_grants').select('id, member_id, domain, capability, effect').eq('family_id', familyId),
    supabase.from('trust_delegations').select('*').eq('family_id', familyId).is('revoked_at', null).gt('expires_at', nowIso).order('expires_at'),
    supabase.from('approval_requests').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(50),
    supabase.from('emergency_sessions').select('*').eq('family_id', familyId).is('ended_at', null),
    supabase.from('trust_audit_logs').select('id, actor_kind, actor_id, domain, capability, decision, reason, policy_id, confidence, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(40),
    // M24 — the Activity tab's own reads (tool-call ledger, autonomy dials,
    // what each request read and what policy withheld). Deliberately NOT in the
    // fail-closed set below: a broken `ai_tool_calls` read must not blank the
    // permissions console beside it. It fails closed inside its own tab, which
    // renders a retryable error rather than an empty ledger.
    loadTrustActivity(scope),
  ]);

  // Trust is a security-state surface: the policies, grants, delegations,
  // pending approvals, and *active emergency sessions* are the source of truth
  // for who can do what. A dropped error would render all of them as "none" — a
  // reassuring-but-wrong picture where a child looks unrestricted, a pending
  // approval vanishes, or an active emergency-access session is hidden. Fail
  // closed on a real read error; a genuinely missing table (unapplied
  // migration) is still tolerated as empty. The trust_audit_logs display below
  // stays best-effort (a historical log view, consistent with audit-log
  // leniency elsewhere).
  const trustError = [membersRes.error, policiesRes.error, grantsRes.error, delegationsRes.error, approvalsRes.error, emergenciesRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (trustError) {
    console.error('[dashboard/trust] trust read failed', trustError);
    return <ErrorState message={t('trust.couldNotLoadYourFamily')} />;
  }

  const members = membersRes.data;
  const policies = policiesRes.data;
  const grants = grantsRes.data;
  const delegations = delegationsRes.data;
  const approvals = approvalsRes.data;
  const emergencies = emergenciesRes.data;

  // "Based on" (M24): the context slice NAMES behind each pending approval, so
  // a parent can see what the request was built from before they say yes.
  // Manager-only and names-only — both enforced in lib/trust/activity.ts. A
  // failed read (already logged there) leaves the map empty and the card draws
  // no expander; an empty "Based on" would be a claim this read cannot support.
  const approvalRows = (approvals ?? []) as unknown as { id: string; status: string; request_id: string | null }[];
  const pendingRequestIds = approvalRows.filter((a) => a.status === 'pending').map((a) => a.request_id);
  const basedOnRes = await loadApprovalBasedOn(scope, pendingRequestIds);
  const basedOn: Record<string, BasedOn> = {};
  if (basedOnRes.ok) {
    for (const row of approvalRows) {
      const entry = row.request_id ? basedOnRes.data[row.request_id] : undefined;
      if (entry) basedOn[row.id] = entry;
    }
  }

  const data: TrustData = {
    members: (members ?? []).map(m => ({ id: m.id, name: m.display_name, role: m.role, color: m.color })),
    policies: (policies ?? []) as unknown as TrustData['policies'],
    grants: (grants ?? []) as unknown as TrustData['grants'],
    delegations: (delegations ?? []) as unknown as TrustData['delegations'],
    approvals: (approvals ?? []) as unknown as TrustData['approvals'],
    emergencies: (emergencies ?? []) as unknown as TrustData['emergencies'],
    audit: (audit ?? []) as unknown as TrustData['audit'],
    activity: activityRes.ok ? activityRes.data : null,
    activityError: activityRes.ok ? null : t('trustActivity.couldNotLoadActivity'),
    basedOn,
  };

  // The approvals inbox is one part of what needs a person; the M5 queue at
  // /dashboard/needs-you carries the rest (money approvals, parked runs,
  // memories to confirm, messages to answer, forms to sign), uncapped.
  return <TrustModule data={data} canManage={isManager(ctx.active.role)} needsYouHref="/dashboard/needs-you" />;
}
