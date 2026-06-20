import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Database, Calendar, ShieldCheck, Clock, CheckCircle2, AlertTriangle, XCircle,
  Download, Info, Cloud, History, FileText, Settings, ArrowRight, RotateCcw,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdminSettings } from '@/app/(app)/admin/settings/actions';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { BigDonut } from '@/components/admin/charts';
import { BackupNowButton, DeleteBackupButton } from '@/components/admin/backup-actions';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Backup & Restore', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TABS = ['Backups', 'Restore', 'Backup Settings'] as const;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
const CAP = 5 * 1024 ** 4; // 5 TB backup storage cap

function fmtBytes(b: number): string {
  if (b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i <= 1 ? 0 : 2)} ${u[i]}`;
}

type SP = { searchParams: Promise<{ tab?: string }> };

export default async function AdminBackupPage({ searchParams }: SP) {
  const sp = await searchParams;
  const activeTab = TABS.find((t) => slug(t) === sp.tab) ?? 'Backups';
  const supabase = createServiceClient();

  const [{ data: backups }, settings, { data: docs }] = await Promise.all([
    supabase.from('system_backups').select('*').order('created_at', { ascending: false }).limit(50),
    getAdminSettings(),
    supabase.from('documents').select('size_bytes'),
  ]);
  const rows = backups ?? [];
  const liveBytes = (docs ?? []).reduce((s, d) => s + (d.size_bytes ?? 0), 0);

  const latest = rows[0] ?? null;
  const totalBackedUp = rows.reduce((s, b) => s + (b.size_bytes ?? 0), 0);
  const storageUsed = totalBackedUp;
  const storagePct = Math.min(100, Math.round((storageUsed / CAP) * 1000) / 10);

  // Next scheduled backup from the configured frequency.
  const freqMs = settings.backupFrequency === 'Hourly' ? 3_600_000 : settings.backupFrequency === 'Weekly' ? 7 * 86_400_000 : 86_400_000;
  const nextAt = new Date((latest ? new Date(latest.created_at).getTime() : Date.now()) + freqMs);

  const statusCounts = { completed: 0, warning: 0, failed: 0, running: 0 } as Record<string, number>;
  for (const b of rows) statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1;
  const lastOk = latest?.status === 'completed';

  const STATUS: Record<string, { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }> = {
    completed: { label: 'Completed', tone: 'text-emerald-400', icon: CheckCircle2 },
    warning: { label: 'Warning', tone: 'text-amber-400', icon: AlertTriangle },
    failed: { label: 'Failed', tone: 'text-rose-400', icon: XCircle },
    running: { label: 'Running', tone: 'text-blue-400', icon: Clock },
  };

  return (
    <div className="module-page space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Backup &amp; Restore</h1>
          <p className="mt-1 text-sm text-muted">Protect your data by creating backups and restoring your system when needed.</p>
        </div>
        <div className="flex gap-2">
          <BackupNowButton />
          <Link href="/admin/settings" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/40 px-3.5 py-2 text-sm font-medium hover:bg-elevated"><Calendar className="h-4 w-4" /> Schedule Backup</Link>
        </div>
      </div>

      <div className="tab-bar border-b border-border">
        {TABS.map((t) => (
          <Link key={t} href={`/admin/backup?tab=${slug(t)}`} className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', activeTab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-fg')}>{t}</Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {activeTab === 'Backups' && (
            <>
              <Card>
                <h2 className="mb-3 text-base font-semibold">Backup Overview</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { icon: Database, tint: 'text-violet-400 bg-violet-500/15', label: 'Total Backups', value: String(rows.length), sub: 'All time' },
                    { icon: Calendar, tint: 'text-emerald-400 bg-emerald-500/15', label: 'Latest Backup', value: latest ? fmtDate(latest.created_at, 'MMM d, yyyy') : '—', sub: latest ? fmtDate(latest.created_at, 'h:mm a') : 'No backups yet' },
                    { icon: ShieldCheck, tint: 'text-blue-400 bg-blue-500/15', label: 'Total Data Backed Up', value: fmtBytes(totalBackedUp), sub: 'Across checkpoints' },
                    { icon: Clock, tint: 'text-amber-400 bg-amber-500/15', label: 'Next Scheduled', value: fmtDate(nextAt.toISOString(), 'MMM d, yyyy'), sub: `${settings.backupFrequency} · ${fmtDate(nextAt.toISOString(), 'h:mm a')}` },
                  ].map((s) => (
                    <div key={s.label} className="rounded-xl border border-border bg-surface/40 p-3">
                      <span className={cn('inline-flex h-9 w-9 items-center justify-center rounded-lg', s.tint)}><s.icon className="h-4 w-4" /></span>
                      <p className="mt-2 text-base font-bold leading-tight">{s.value}</p>
                      <p className="text-xs font-medium text-muted">{s.label}</p>
                      <p className="text-[11px] text-muted">{s.sub}</p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <h2 className="mb-3 text-base font-semibold">Backup History</h2>
                {rows.length === 0 ? (
                  <EmptyState icon={Database} title="No backups yet" description="Run “Backup Now” to record your first checkpoint." />
                ) : (
                  <div className="table-responsive">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead><tr className="border-b border-border text-left text-xs text-muted">
                        <th className="pb-2 pr-3 font-medium">Backup</th><th className="pb-2 pr-3 font-medium">Type</th>
                        <th className="pb-2 pr-3 font-medium">Data Size</th><th className="pb-2 pr-3 font-medium">Date &amp; Time</th>
                        <th className="pb-2 pr-3 font-medium">Status</th><th className="pb-2 font-medium">Actions</th>
                      </tr></thead>
                      <tbody>
                        {rows.map((b) => {
                          const m = STATUS[b.status] ?? STATUS.completed;
                          return (
                            <tr key={b.id} className="border-b border-border/50 last:border-0">
                              <td className="py-2.5 pr-3"><span className="flex items-center gap-2"><Database className="h-4 w-4 text-muted" /><span className="font-medium">{b.label}</span></span></td>
                              <td className="py-2.5 pr-3"><span className="rounded-md bg-white/5 px-2 py-0.5 text-xs capitalize text-muted">{b.kind}</span></td>
                              <td className="py-2.5 pr-3">{fmtBytes(b.size_bytes)}</td>
                              <td className="py-2.5 pr-3 text-xs text-muted">{fmtDate(b.created_at, 'MMM d, yyyy h:mm a')}</td>
                              <td className="py-2.5 pr-3"><span className={cn('inline-flex items-center gap-1 text-xs font-medium', m.tone)}><m.icon className="h-3.5 w-3.5" />{m.label}</span></td>
                              <td className="py-2.5"><div className="flex items-center gap-2 text-muted"><Download className="h-4 w-4" /><DeleteBackupButton id={b.id} /></div></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <div className="grid gap-4 sm:grid-cols-2">
                <Card>
                  <h2 className="mb-3 text-base font-semibold">Backup Location</h2>
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3">
                    <Cloud className="h-5 w-5 text-violet-400" />
                    <div className="min-w-0 flex-1"><p className="text-sm font-medium">Supabase (managed)</p><p className="text-xs text-muted">Encrypted, point-in-time recovery</p></div>
                    <span className="text-xs font-medium text-emerald-400">Active</span>
                  </div>
                  <p className="mt-2 text-xs text-muted">Live document storage: {fmtBytes(liveBytes)}.</p>
                </Card>
                <Card>
                  <h2 className="mb-3 text-base font-semibold">Backup Retention Policy</h2>
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center justify-between"><span className="text-muted">Full Backups</span><span className="font-medium">Keep for 30 days</span></li>
                    <li className="flex items-center justify-between"><span className="text-muted">Incremental Backups</span><span className="font-medium">Keep for 7 days</span></li>
                    <li className="flex items-center justify-between"><span className="text-muted">User Data</span><span className="font-medium">{settings.dataRetentionYears} years</span></li>
                  </ul>
                  <Link href="/admin/settings?tab=privacy" className="mt-2 block text-xs font-medium text-brand hover:underline">Manage retention policy →</Link>
                </Card>
              </div>
            </>
          )}

          {activeTab === 'Restore' && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Restore</h2>
              <p className="text-sm text-muted">FamilyOS data runs on Supabase with continuous point-in-time recovery. To restore to an earlier state, use the Supabase dashboard&apos;s database backups (PITR), then verify against the checkpoints listed here.</p>
              <Link href="https://supabase.com/dashboard/project/_/database/backups" target="_blank" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">Open Supabase backups <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Card>
          )}

          {activeTab === 'Backup Settings' && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Backup Settings</h2>
              <ul className="space-y-2 text-sm">
                <li className="flex items-center justify-between"><span className="text-muted">Backup Frequency</span><span className="font-medium">{settings.backupFrequency}</span></li>
                <li className="flex items-center justify-between"><span className="text-muted">Data Retention</span><span className="font-medium">{settings.dataRetentionYears} years</span></li>
                <li className="flex items-center justify-between"><span className="text-muted">Storage Limit</span><span className="font-medium">{settings.storageLimitTB} TB</span></li>
              </ul>
              <Link href="/admin/settings" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">Edit in Settings <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Card>
          )}
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          <Card>
            <div className="flex flex-col items-center text-center">
              <span className={cn('grid h-16 w-16 place-items-center rounded-full', lastOk ? 'bg-emerald-500/15 text-emerald-400' : rows.length ? 'bg-amber-500/15 text-amber-400' : 'bg-white/10 text-muted')}><ShieldCheck className="h-8 w-8" /></span>
              <p className={cn('mt-2 font-semibold', lastOk ? 'text-emerald-400' : 'text-fg')}>{rows.length === 0 ? 'No backups yet' : lastOk ? 'Your backups are protected' : 'Last backup needs attention'}</p>
              <p className="text-xs text-muted">{latest ? `Last checkpoint ${fmtDate(latest.created_at, 'MMM d, yyyy h:mm a')}` : 'Run a backup to get started'}</p>
            </div>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex items-center justify-between"><span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> Backup Service</span><span className="font-medium text-emerald-400">Active</span></li>
              <li className="flex items-center justify-between"><span className="flex items-center gap-2"><History className="h-4 w-4 text-muted" /> Last Backup Status</span><span className={cn('font-medium', latest ? (STATUS[latest.status]?.tone ?? 'text-muted') : 'text-muted')}>{latest ? (STATUS[latest.status]?.label ?? latest.status) : '—'}</span></li>
              <li className="flex items-center justify-between"><span className="flex items-center gap-2"><Clock className="h-4 w-4 text-muted" /> Next Backup</span><span className="font-medium">{fmtDate(nextAt.toISOString(), 'MMM d, h:mm a')}</span></li>
            </ul>
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs"><span className="text-muted">Backup Storage Used</span><span className="font-medium">{fmtBytes(storageUsed)} of {fmtBytes(CAP)}</span></div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500" style={{ width: `${Math.max(1, storagePct)}%` }} /></div>
              <p className="mt-1 text-right text-[11px] text-muted">{storagePct}% used</p>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Backup Status by Result</h2>
            <div className="flex items-center gap-3">
              <BigDonut
                segments={[
                  { value: statusCounts.completed, color: '#22c55e' },
                  { value: statusCounts.warning, color: '#f59e0b' },
                  { value: statusCounts.failed, color: '#ef4444' },
                  { value: statusCounts.running, color: '#3b82f6' },
                ]}
                centerTop={String(rows.length)} centerBottom="Backups" size={130}
              />
              <ul className="flex-1 space-y-1.5 text-xs">
                {[['completed', '#22c55e', 'Completed'], ['warning', '#f59e0b', 'Warning'], ['failed', '#ef4444', 'Failed'], ['running', '#3b82f6', 'Running']].map(([k, c, l]) => (
                  <li key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} /><span className="text-muted">{l}</span><span className="ml-auto font-semibold">{statusCounts[k] ?? 0}</span></li>
                ))}
              </ul>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Quick Actions</h2>
            <ul className="space-y-1">
              {[
                { icon: Cloud, label: 'Backup Now', desc: 'Create an immediate checkpoint', href: '#', action: true },
                { icon: RotateCcw, label: 'Restore Data', desc: 'Restore from a backup', href: '/admin/backup?tab=restore' },
                { icon: FileText, label: 'View Backup Logs', desc: 'View backup activity', href: '/admin/audit' },
                { icon: Settings, label: 'Backup Settings', desc: 'Configure preferences', href: '/admin/settings' },
              ].map((a) => a.action ? (
                <li key={a.label} className="flex items-center gap-3 rounded-lg px-2 py-2"><a.icon className="h-4 w-4 text-brand" /><div className="flex-1"><p className="text-sm font-medium">{a.label}</p><p className="text-xs text-muted">{a.desc}</p></div><BackupNowButton /></li>
              ) : (
                <li key={a.label}><Link href={a.href} className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-elevated"><a.icon className="h-4 w-4 text-brand" /><div className="flex-1"><p className="text-sm font-medium">{a.label}</p><p className="text-xs text-muted">{a.desc}</p></div><ArrowRight className="h-4 w-4 text-muted" /></Link></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted"><Info className="h-3.5 w-3.5" /> Encrypted full-data backups run continuously via Supabase managed PITR; checkpoints above capture application-level metrics.</p>
    </div>
  );
}
