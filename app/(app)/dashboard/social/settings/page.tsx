import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getSocialAccess } from '@/lib/social/access';
import { updateSettingsAction, grantAccessAction } from '@/app/(app)/dashboard/social/actions';
import { SOCIAL_ROLES, SOCIAL_ROLE_LABELS, defaultSocialRoleForMember } from '@/lib/social/roles';
import { PLATFORMS, PROVIDERS } from '@/lib/social/capabilities';
import { isMissingTableError } from '@/lib/supabase/errors';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Settings · Social' };
export const dynamic = 'force-dynamic';

export default async function SocialSettingsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [settingsRes, membersRes, permsRes, access] = await Promise.all([
    supabase.from('social_settings').select('*').eq('family_id', familyId).maybeSingle(),
    supabase.from('family_members').select('id, user_id, display_name, role').eq('family_id', familyId).eq('is_active', true),
    supabase.from('social_access_permissions').select('user_id, social_role').eq('family_id', familyId),
    getSocialAccess(familyId),
  ]);

  // Fail closed: a dropped social_settings error would render the form with
  // DEFAULT values (UTC / friendly / no platforms), and saving would silently
  // OVERWRITE the family's real settings with those defaults — a data-loss trap.
  // A dropped members/perms error would likewise hide access config. A genuinely
  // missing table (unapplied migration) is still tolerated as empty.
  const socialError = [settingsRes.error, membersRes.error, permsRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (socialError) {
    console.error('[dashboard/social/settings] social settings read failed', socialError);
    return <ErrorState message="Could not load your social workspace settings from Supabase. Refresh and try again." />;
  }

  const settings = settingsRes.data;
  const members = membersRes.data;
  const perms = permsRes.data;

  const permByUser = new Map((perms ?? []).map((p) => [p.user_id, p.social_role]));
  const canManage = access?.can('manage_settings') ?? false;
  const defaultPlatforms = new Set(settings?.default_platforms ?? []);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h2 className="mb-3 text-sm font-semibold">{t('dashboardSocialSettings.workspaceSettings')}</h2>
        <form action={updateSettingsAction} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('dashboardSocialSettings.defaultTimezone')}</label>
            <input name="default_timezone" defaultValue={settings?.default_timezone ?? 'UTC'} className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('dashboardSocialSettings.aiTone')}</label>
            <input name="ai_tone" defaultValue={settings?.ai_tone ?? 'friendly'} className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('dashboardSocialSettings.signatureAppendedOnSupportedPlatforms')}</label>
            <input name="signature" defaultValue={settings?.signature ?? ''} className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('dashboardSocialSettings.defaultPlatforms')}</label>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <label key={p} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs">
                  <input type="checkbox" name="default_platforms" value={p} defaultChecked={defaultPlatforms.has(p)} />
                  {PROVIDERS[p].label}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="require_approval" defaultChecked={settings?.require_approval ?? false} /> {t('dashboardSocialSettings.requireApprovalBeforePublishing')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="auto_hashtags" defaultChecked={settings?.auto_hashtags ?? true} /> {t('dashboardSocialSettings.autoExtractHashtagsIntoVariants')}
          </label>
          <button disabled={!canManage} className="h-9 rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg disabled:opacity-50">{t('dashboardSocialSettings.saveSettings')}</button>
          {!canManage && <p className="text-[11px] text-muted">{t('dashboardSocialSettings.yourRoleCantChangeSettings')}</p>}
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">{t('dashboardSocialSettings.accessControl')}</h2>
        <p className="mb-3 text-xs text-muted">{t('dashboardSocialSettings.grantASocialRolePerFamily')}</p>
        <div className="space-y-2">
          {(members ?? []).filter((m): m is typeof m & { user_id: string } => Boolean(m.user_id)).map((m) => {
            const explicit = permByUser.get(m.user_id);
            const effective = explicit ?? defaultSocialRoleForMember(m.role);
            return (
              <form key={m.id} action={grantAccessAction} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
                <input type="hidden" name="user_id" value={m.user_id} />
                <span className="min-w-0 flex-1 truncate text-sm">{m.display_name ?? 'Member'}</span>
                {!explicit && <Badge tone="neutral" title={t('settings.defaultByHouseholdRole')}>default</Badge>}
                <select name="social_role" defaultValue={effective} disabled={!canManage} className="rounded-lg border border-border bg-elevated px-2 py-1 text-xs">
                  {SOCIAL_ROLES.map((r) => <option key={r} value={r}>{SOCIAL_ROLE_LABELS[r]}</option>)}
                </select>
                <button disabled={!canManage} className="rounded-lg bg-elevated px-2 py-1 text-xs font-medium disabled:opacity-50">Set</button>
              </form>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
