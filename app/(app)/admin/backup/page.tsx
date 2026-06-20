'use client';

import { useState } from 'react';
import {
  Database, Clock, Shield, HardDrive, Cloud, Download,
  Info, MoreHorizontal, CheckCircle, AlertTriangle, XCircle,
  ChevronRight, Calendar, Settings, RotateCcw, FileText, Server
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const TABS = ['Backups', 'Restore', 'Backup Settings'];

const BACKUPS = [
  { name: 'Automatic Backup',    sub: 'Full System Backup',    type: 'Full',        size: '256.8 GB', date: 'May 14, 2024', time: '02:30 AM', status: 'Completed' },
  { name: 'Pre-Update Backup',   sub: 'System Backup',         type: 'Full',        size: '248.3 GB', date: 'May 13, 2024', time: '02:30 AM', status: 'Completed' },
  { name: 'Daily Backup',        sub: 'Incremental Backup',    type: 'Incremental', size: '12.4 GB',  date: 'May 12, 2024', time: '02:30 AM', status: 'Completed' },
  { name: 'Daily Backup',        sub: 'Incremental Backup',    type: 'Incremental', size: '11.7 GB',  date: 'May 11, 2024', time: '02:30 AM', status: 'Completed' },
  { name: 'Weekly Backup',       sub: 'Full System Backup',    type: 'Full',        size: '255.1 GB', date: 'May 7, 2024',  time: '02:30 AM', status: 'Completed' },
  { name: 'Daily Backup',        sub: 'Incremental Backup',    type: 'Incremental', size: '10.9 GB',  date: 'May 6, 2024',  time: '02:30 AM', status: 'Warning' },
  { name: 'Daily Backup',        sub: 'Incremental Backup',    type: 'Incremental', size: '11.2 GB',  date: 'May 5, 2024',  time: '02:30 AM', status: 'Failed' },
  { name: 'Daily Backup',        sub: 'Incremental Backup',    type: 'Incremental', size: '11.5 GB',  date: 'May 4, 2024',  time: '02:30 AM', status: 'Completed' },
];

const STORAGE_DATA = [
  { name: 'System Data',   gb: 512, pct: 40.6, color: '#8b5cf6' },
  { name: 'User Data',     gb: 384, pct: 30.5, color: '#6366f1' },
  { name: 'Media Content', gb: 256, pct: 20.3, color: '#f59e0b' },
  { name: 'Others',        gb: 88,  pct: 7.0,  color: '#6b7280' },
];

function StorageDonut() {
  const r = 40, circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="rotate-[-90deg]">
          {STORAGE_DATA.map((d) => {
            const dash = (d.pct / 100) * circ;
            const gap = circ - dash;
            const el = (
              <circle key={d.name} cx="50" cy="50" r={r}
                fill="none" stroke={d.color} strokeWidth="18"
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={-offset * circ / 100}
              />
            );
            offset += d.pct;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-base font-bold">1.24</span>
          <span className="text-[10px] text-muted">TB Used</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-xs">
        {STORAGE_DATA.map((d) => (
          <div key={d.name} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: d.color }} />
            <span className="text-muted">{d.name}</span>
            <span className="ml-auto font-medium">{d.gb} GB ({d.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'Completed') return (
    <span className="flex items-center gap-1 text-success text-xs font-medium">
      <CheckCircle className="h-3.5 w-3.5" /> Completed
    </span>
  );
  if (status === 'Warning') return (
    <span className="flex items-center gap-1 text-warning text-xs font-medium">
      <AlertTriangle className="h-3.5 w-3.5" /> Warning
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-danger text-xs font-medium">
      <XCircle className="h-3.5 w-3.5" /> Failed
    </span>
  );
}

export default function AdminBackupPage() {
  const [tab, setTab] = useState('Backups');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Backup &amp; Restore</h1>
          <p className="text-sm text-muted">Protect your data by creating backups and restoring your system when needed.</p>
        </div>
        <div className="flex gap-2">
          <button className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90">
            <Cloud className="h-4 w-4" /> Backup Now
          </button>
          <button className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-4 py-2 text-sm font-medium hover:bg-elevated">
            <Calendar className="h-4 w-4" /> Schedule Backup
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-bar">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn('tab-item', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>
            {t}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-6">
          {/* Overview stats */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Total Backups',         value: '48',               sub: 'All time',              icon: Database,  color: 'text-brand' },
              { label: 'Latest Backup',         value: 'May 14, 2024',     sub: '02:30 AM',              icon: Clock,     color: 'text-success' },
              { label: 'Total Data Backed Up',  value: '1.24 TB',          sub: 'Compressed',            icon: Shield,    color: 'text-indigo-400' },
              { label: 'Next Scheduled Backup', value: 'May 15, 2024',     sub: '02:30 AM',              icon: Clock,     color: 'text-warning' },
            ].map((s) => (
              <div key={s.label} className="card flex items-start gap-3">
                <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface/80', s.color)}>
                  <s.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className="text-lg font-bold leading-tight">{s.value}</p>
                  <p className="text-xs text-muted">{s.sub}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Backup History */}
          <div className="card">
            <h3 className="mb-4 font-semibold">Backup History</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    {['Backup Name','Type','Data Size','Date & Time','Status','Actions'].map((h) => (
                      <th key={h} className="pb-2 pr-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {BACKUPS.map((b, i) => (
                    <tr key={i} className="text-sm">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <Database className="h-4 w-4 text-muted" />
                          <div>
                            <p className="font-medium">{b.name}</p>
                            <p className="text-xs text-muted">{b.sub}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium',
                          b.type === 'Full' ? 'bg-brand/15 text-brand' : 'bg-indigo-500/15 text-indigo-400'
                        )}>{b.type}</span>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="font-medium">{b.size}</p>
                        <p className="text-xs text-muted">Compressed</p>
                      </td>
                      <td className="py-3 pr-4">
                        <p>{b.date}</p>
                        <p className="text-xs text-muted">{b.time}</p>
                      </td>
                      <td className="py-3 pr-4"><StatusBadge status={b.status} /></td>
                      <td className="py-3">
                        <div className="flex items-center gap-1">
                          <button className="rounded-lg p-1.5 hover:bg-elevated"><Download className="h-4 w-4 text-muted" /></button>
                          <button className="rounded-lg p-1.5 hover:bg-elevated"><Info className="h-4 w-4 text-muted" /></button>
                          <button className="rounded-lg p-1.5 hover:bg-elevated"><MoreHorizontal className="h-4 w-4 text-muted" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center justify-between text-xs text-muted">
              <span>Showing 1 to 8 of 48 backups</span>
              <div className="flex items-center gap-1">
                {[1,2,3,'…',6].map((p) => (
                  <button key={p} className={cn('h-7 min-w-7 rounded-lg px-2 text-xs', p === 1 ? 'bg-brand text-white' : 'hover:bg-elevated')}>{p}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Bottom row */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Backup Locations */}
            <div className="card">
              <h3 className="mb-4 font-semibold">Backup Locations</h3>
              <div className="space-y-3">
                {[
                  { name: 'Primary Location (AWS S3)',        sub: 'us-east-1',                used: '1.24 TB / 3 TB',  pct: 41.3, icon: Cloud,    color: 'text-brand' },
                  { name: 'Secondary Location (Google Cloud)',sub: 'us-central1',              used: '512 GB / 2 TB',   pct: 25.6, icon: Cloud,    color: 'text-indigo-400' },
                  { name: 'Local Backup (On-Premise)',        sub: 'FamilyOS Backup Server',   used: '256 GB / 1 TB',   pct: 25.6, icon: Server,   color: 'text-muted' },
                ].map((loc) => (
                  <div key={loc.name} className="flex items-start gap-3">
                    <span className={cn('mt-0.5 shrink-0', loc.color)}>
                      <loc.icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{loc.name}</p>
                      <p className="text-xs text-muted">{loc.sub}</p>
                      <div className="mt-1.5 flex items-center justify-between text-xs">
                        <span className="text-muted">{loc.used}</span>
                        <span className="text-warning font-medium">{loc.pct}% Used</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-elevated">
                        <div className="h-full rounded-full bg-warning" style={{ width: `${loc.pct}%` }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Backup Retention Policy */}
            <div className="card">
              <h3 className="mb-4 font-semibold">Backup Retention Policy</h3>
              <div className="space-y-3 text-sm">
                {[
                  { label: 'Full Backups',       policy: 'Keep for 30 days' },
                  { label: 'Incremental Backups',policy: 'Keep for 7 days' },
                  { label: 'Transaction Logs',   policy: 'Keep for 3 days' },
                ].map((r) => (
                  <div key={r.label} className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
                    <span className="font-medium">{r.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-muted">{r.policy}</span>
                      <Calendar className="h-4 w-4 text-muted" />
                    </div>
                  </div>
                ))}
              </div>
              <button className="mt-4 text-xs text-brand hover:underline">Manage Retention Policy →</button>
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Backup Status */}
          <div className="card text-center">
            <h3 className="mb-4 font-semibold text-left">Backup Status</h3>
            <div className="flex justify-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-success/15">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-success">
                  <CheckCircle className="h-8 w-8 text-success" />
                </div>
              </div>
            </div>
            <p className="mt-3 font-semibold text-success">Your backups are protected</p>
            <p className="mt-1 text-xs text-muted">Last backup completed successfully</p>
            <p className="text-xs text-muted">May 14, 2024 at 02:30 AM</p>

            <div className="mt-4 space-y-2 text-left text-sm">
              {[
                { label: 'Backup Service',    value: 'Active',      vColor: 'text-success' },
                { label: 'Last Backup Status',value: 'Successful',  vColor: 'text-success' },
                { label: 'Next Backup',       value: 'May 15, 2024, 02:30 AM', vColor: '' },
                { label: 'Backup Storage Used',value:'1.24 TB of 5 TB',        vColor: '' },
              ].map((r) => (
                <div key={r.label}>
                  <div className="flex justify-between">
                    <span className="text-muted">{r.label}</span>
                    <span className={cn('font-medium text-xs', r.vColor || 'text-fg')}>{r.value}</span>
                  </div>
                  {r.label === 'Backup Storage Used' && (
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-elevated">
                      <div className="h-full rounded-full bg-success" style={{ width: '24.8%' }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Backup Storage */}
          <div className="card">
            <h3 className="mb-4 font-semibold">Backup Storage</h3>
            <StorageDonut />
            <p className="mt-4 text-xs text-muted">Total Storage: 5 TB</p>
            <button className="mt-1 text-xs text-brand hover:underline">Manage Storage →</button>
          </div>

          {/* Quick Actions */}
          <div className="card">
            <h3 className="mb-3 font-semibold">Quick Actions</h3>
            <div className="space-y-1">
              {[
                { label: 'Backup Now',       sub: 'Create an immediate backup', icon: Cloud },
                { label: 'Restore Data',     sub: 'Restore from an existing backup', icon: RotateCcw },
                { label: 'View Backup Logs', sub: 'View backup activity logs', icon: FileText },
                { label: 'Backup Settings',  sub: 'Configure backup preferences', icon: Settings },
              ].map((a) => (
                <button key={a.label} className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-elevated">
                  <a.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{a.label}</p>
                    <p className="text-xs text-muted">{a.sub}</p>
                  </div>
                  <ChevronRight className="mt-0.5 h-4 w-4 text-muted" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
