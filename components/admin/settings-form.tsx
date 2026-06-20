'use client';
// Admin Settings — a single client form over the whole persisted settings blob.
// Renders the fields for the active tab; Save/Reset write through server actions.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Settings as Cog, ShieldCheck, Bell, Database, Puzzle, Info, AlertTriangle,
  Save, RotateCcw, Loader2, Check, ChevronRight, Trash2,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import {
  saveAdminSettings, resetAdminSettings, type AdminSettings,
} from '@/app/(app)/admin/settings/actions';
import { adminClearCacheAction } from '@/app/(app)/admin/actions';

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition', on ? 'bg-brand' : 'bg-white/15')}>
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

const inputCls = 'mt-1 w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none transition focus:border-brand/60';

function ToggleRow({ title, desc, on, onChange }: { title: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div><p className="text-sm font-medium">{title}</p><p className="text-xs text-muted">{desc}</p></div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

export function SettingsForm({
  initial, tab, systemInfo, integrations,
}: {
  initial: AdminSettings; tab: string;
  systemInfo: { version: string; environment: string; region: string; lastUpdated: string };
  integrations: { label: string; status: string; tone: string }[];
}) {
  const router = useRouter();
  const [s, setS] = useState<AdminSettings>(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AdminSettings>(k: K, v: AdminSettings[K]) => { setS((p) => ({ ...p, [k]: v })); setSaved(false); };

  const save = () => start(async () => {
    setError(null);
    const res = await saveAdminSettings(s);
    if (res.ok) { setSaved(true); router.refresh(); setTimeout(() => setSaved(false), 2000); }
    else setError(res.error);
  });
  const reset = () => start(async () => {
    const res = await resetAdminSettings();
    if (res.ok) { router.refresh(); window.location.reload(); } else setError(res.error);
  });

  const showGeneral = tab === 'general';
  const showLocale = tab === 'general' || tab === 'localization';
  const showNotif = tab === 'general' || tab === 'notifications';
  const showSecurity = tab === 'general' || tab === 'system-configuration' || tab === 'user-management';
  const showData = tab === 'general' || tab === 'privacy';
  const showAdvanced = tab === 'general' || tab === 'advanced';

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-end gap-2">
        {error && <span className="mr-auto text-sm text-danger">{error}</span>}
        <button type="button" onClick={reset} disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/40 px-3.5 py-2 text-sm font-medium hover:bg-elevated disabled:opacity-50">
          <RotateCcw className="h-4 w-4" /> Reset to Defaults
        </button>
        <button type="button" onClick={save} disabled={pending}
          className="btn-cta">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? 'Saved' : 'Save Changes'}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Column 1 */}
        <div className="space-y-4">
          {(showGeneral || showLocale) && (
            <Card>
              <div className="mb-3 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><Cog className="h-5 w-5" /></span><div><h2 className="text-sm font-semibold">Platform Settings</h2><p className="text-xs text-muted">Configure basic information about your FamilyOS system.</p></div></div>
              <div className="space-y-3">
                {showGeneral && <div className="grid grid-cols-2 gap-3">
                  <Field label="Platform Name"><input className={inputCls} value={s.platformName} onChange={(e) => set('platformName', e.target.value)} /></Field>
                  <Field label="Platform Tagline"><input className={inputCls} value={s.tagline} onChange={(e) => set('tagline', e.target.value)} /></Field>
                </div>}
                {showLocale && <>
                  <Field label="Default Timezone">
                    <select className={inputCls} value={s.timezone} onChange={(e) => set('timezone', e.target.value)}>
                      {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC', 'Europe/London'].map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Date Format">
                      <select className={inputCls} value={s.dateFormat} onChange={(e) => set('dateFormat', e.target.value)}>
                        {['MMM DD, YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </Field>
                    <Field label="Time Format">
                      <select className={inputCls} value={s.timeFormat} onChange={(e) => set('timeFormat', e.target.value as AdminSettings['timeFormat'])}>
                        <option value="12h">12-Hour (AM/PM)</option><option value="24h">24-Hour</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="Week Starts On">
                    <select className={inputCls} value={s.weekStartsOn} onChange={(e) => set('weekStartsOn', e.target.value as AdminSettings['weekStartsOn'])}>
                      <option value="Sunday">Sunday</option><option value="Monday">Monday</option>
                    </select>
                  </Field>
                </>}
                {showAdvanced && <ToggleRow title="Enable Maintenance Mode" desc="When enabled, only administrators can access the system." on={s.maintenanceMode} onChange={(v) => set('maintenanceMode', v)} />}
              </div>
            </Card>
          )}

          {showData && (
            <Card>
              <div className="mb-3 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><Database className="h-5 w-5" /></span><div><h2 className="text-sm font-semibold">Storage &amp; Data Settings</h2><p className="text-xs text-muted">Manage storage limits and data retention policies.</p></div></div>
              <div className="space-y-3">
                <Field label="Total Storage Limit (TB)"><input type="number" className={inputCls} value={s.storageLimitTB} onChange={(e) => set('storageLimitTB', Number(e.target.value))} /></Field>
                <Field label="Data Retention Period (years)"><input type="number" className={inputCls} value={s.dataRetentionYears} onChange={(e) => set('dataRetentionYears', Number(e.target.value))} /></Field>
                <ToggleRow title="Auto Delete Inactive Accounts" desc="Automatically delete inactive accounts" on={s.autoDeleteInactive} onChange={(v) => set('autoDeleteInactive', v)} />
                <Field label="Content Backup Frequency">
                  <select className={inputCls} value={s.backupFrequency} onChange={(e) => set('backupFrequency', e.target.value as AdminSettings['backupFrequency'])}>
                    {['Hourly', 'Daily', 'Weekly'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
              </div>
            </Card>
          )}
        </div>

        {/* Column 2 */}
        <div className="space-y-4">
          {showSecurity && (
            <Card>
              <div className="mb-3 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><ShieldCheck className="h-5 w-5" /></span><div><h2 className="text-sm font-semibold">Security Settings</h2><p className="text-xs text-muted">Configure security policies and session management.</p></div></div>
              <div className="space-y-3">
                <Field label="Password Policy">
                  <select className={inputCls} value={s.passwordPolicy} onChange={(e) => set('passwordPolicy', e.target.value as AdminSettings['passwordPolicy'])}>
                    {['Basic', 'Medium', 'Strong'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Session Timeout (min)"><input type="number" className={inputCls} value={s.sessionTimeoutMins} onChange={(e) => set('sessionTimeoutMins', Number(e.target.value))} /></Field>
                  <Field label="Failed Login Attempts"><input type="number" className={inputCls} value={s.failedLoginLimit} onChange={(e) => set('failedLoginLimit', Number(e.target.value))} /></Field>
                </div>
                <ToggleRow title="Two-Factor Authentication (2FA)" desc="Require 2FA for admin accounts" on={s.twoFactor} onChange={(v) => set('twoFactor', v)} />
                <ToggleRow title="IP Whitelisting" desc="Restrict access to trusted IP addresses" on={s.ipWhitelisting} onChange={(v) => set('ipWhitelisting', v)} />
              </div>
            </Card>
          )}

          {showGeneral && (
            <Card>
              <div className="mb-3 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><Puzzle className="h-5 w-5" /></span><div><h2 className="text-sm font-semibold">Integrations Settings</h2><p className="text-xs text-muted">Configure third-party integrations and services.</p></div></div>
              <ul className="space-y-1">
                {integrations.map((i) => (
                  <li key={i.label}>
                    <Link href="/admin/integrations" className="flex items-center justify-between rounded-lg px-1 py-2 text-sm transition hover:bg-elevated">
                      <span className="font-medium">{i.label}</span>
                      <span className="flex items-center gap-1"><span className={cn('text-xs font-medium', i.tone)}>{i.status}</span><ChevronRight className="h-4 w-4 text-muted" /></span>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link href="/admin/integrations" className="mt-2 block text-center text-xs font-medium text-brand hover:underline">Manage integrations →</Link>
            </Card>
          )}
        </div>

        {/* Column 3 */}
        <div className="space-y-4">
          {showNotif && (
            <Card>
              <div className="mb-3 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><Bell className="h-5 w-5" /></span><div><h2 className="text-sm font-semibold">Notification Settings</h2><p className="text-xs text-muted">Manage system and email notifications.</p></div></div>
              <div className="divide-y divide-border">
                <ToggleRow title="New User Registration" desc="Notify when a new user registers" on={s.notifyNewUser} onChange={(v) => set('notifyNewUser', v)} />
                <ToggleRow title="Subscription Updates" desc="Notify about subscription changes" on={s.notifySubscription} onChange={(v) => set('notifySubscription', v)} />
                <ToggleRow title="Payment Notifications" desc="Notify for payment success or failure" on={s.notifyPayment} onChange={(v) => set('notifyPayment', v)} />
                <ToggleRow title="Security Alerts" desc="Notify about security events" on={s.notifySecurity} onChange={(v) => set('notifySecurity', v)} />
                <ToggleRow title="System Alerts" desc="Notify about system issues" on={s.notifySystem} onChange={(v) => set('notifySystem', v)} />
              </div>
              <Link href="/admin/content" className="mt-2 block text-center text-xs font-medium text-brand hover:underline">Manage email templates →</Link>
            </Card>
          )}

          {showGeneral && (
            <>
              <Card>
                <div className="mb-3 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><Info className="h-5 w-5" /></span><div><h2 className="text-sm font-semibold">System Information</h2><p className="text-xs text-muted">View system details and environment information.</p></div></div>
                <ul className="space-y-2 text-sm">
                  <li className="flex justify-between"><span className="text-muted">Current Version</span><span className="font-medium">{systemInfo.version}</span></li>
                  <li className="flex justify-between"><span className="text-muted">Environment</span><span className="font-medium">{systemInfo.environment}</span></li>
                  <li className="flex justify-between"><span className="text-muted">Server Region</span><span className="font-medium">{systemInfo.region}</span></li>
                  <li className="flex justify-between"><span className="text-muted">Last Updated</span><span className="font-medium">{systemInfo.lastUpdated}</span></li>
                </ul>
                <Link href="/admin/system" className="mt-2 block text-center text-xs font-medium text-brand hover:underline">View system health →</Link>
              </Card>

              <Card className="border-danger/30">
                <div className="mb-3 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-danger/15 text-danger"><AlertTriangle className="h-5 w-5" /></span><div><h2 className="text-sm font-semibold">Danger Zone</h2><p className="text-xs text-muted">Irreversible and sensitive actions.</p></div></div>
                <button type="button" onClick={() => start(async () => { await adminClearCacheAction(); router.refresh(); })}
                  className="flex w-full items-center justify-between rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5 text-left transition hover:bg-danger/10">
                  <div><p className="text-sm font-medium text-danger">Clear System Cache</p><p className="text-xs text-muted">Clear cached data to improve performance</p></div>
                  <Trash2 className="h-4 w-4 text-danger" />
                </button>
                <button type="button" onClick={reset}
                  className="mt-2 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2.5 text-left transition hover:bg-elevated">
                  <div><p className="text-sm font-medium">Reset System Settings</p><p className="text-xs text-muted">Reset all settings to default values</p></div>
                  <RotateCcw className="h-4 w-4 text-muted" />
                </button>
              </Card>
            </>
          )}
        </div>
      </div>

      {!showGeneral && !showLocale && !showNotif && !showSecurity && !showData && !showAdvanced && (
        <Card><p className="text-sm text-muted">No editable fields in this section yet — they live under the General tab.</p></Card>
      )}
    </div>
  );
}
