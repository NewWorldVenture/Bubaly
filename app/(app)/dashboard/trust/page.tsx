import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { TrustModule, type TrustData } from '@/components/modules/trust-module';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Trust & Permissions' };
export const dynamic = 'force-dynamic';

export default async function TrustPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const nowIso = new Date().toISOString();

  const [
    membersRes,
    policiesRes,
    grantsRes,
    delegationsRes,
    approvalsRes,
    emergenciesRes,
    { data: audit },
  ] = await settleAll([
    supabase.from('family_members').select('id, display_name, role, color').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('trust_policies').select('*').eq('family_id', familyId).order('priority', { ascending: false }),
    supabase.from('permission_grants').select('id, member_id, domain, capability, effect').eq('family_id', familyId),
    supabase.from('trust_delegations').select('*').eq('family_id', familyId).is('revoked_at', null).gt('expires_at', nowIso).order('expires_at'),
    supabase.from('approval_requests').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(50),
    supabase.from('emergency_sessions').select('*').eq('family_id', familyId).is('ended_at', null),
    supabase.from('trust_audit_logs').select('id, actor_kind, actor_id, domain, capability, decision, reason, confidence, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(40),
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

  const data: TrustData = {
    members: (members ?? []).map(m => ({ id: m.id, name: m.display_name, role: m.role, color: m.color })),
    policies: (policies ?? []) as unknown as TrustData['policies'],
    grants: (grants ?? []) as unknown as TrustData['grants'],
    delegations: (delegations ?? []) as unknown as TrustData['delegations'],
    approvals: (approvals ?? []) as unknown as TrustData['approvals'],
    emergencies: (emergencies ?? []) as unknown as TrustData['emergencies'],
    audit: (audit ?? []) as unknown as TrustData['audit'],
  };

  return <TrustModule data={data} canManage={isManager(ctx.active.role)} />;
}
