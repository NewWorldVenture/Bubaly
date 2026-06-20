'use client';

import { useState } from 'react';
import {
  Settings, Shield, Database, Puzzle, Bell, Info, AlertTriangle,
  ChevronRight, RotateCcw, Save, Trash2
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const TABS = ['General', 'System Configuration', 'User Management', 'Notifications', 'Email Templates', 'Localization', 'Privacy', 'Advanced'];

function Toggle({ defaultOn = false }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      onClick={() => setOn((v) => !v)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors', on ? 'bg-brand' : 'bg-elevated')}
    >
      <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', on ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

function SettingRow({ label, desc, value, valueColor = '' }: { label: string; desc: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between py-3 first:pt-0 last:pb-0 border-b border-border/50 last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">{desc}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className={cn('text-sm font-medium', valueColor || 'text-fg')}>{value}</span>
        <ChevronRight className="h-4 w-4 text-muted" />
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  const [tab, setTab] = useState('General');
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-sm text-muted">Manage system preferences and configuration settings.</p>
        </div>
        <div className="flex gap-2">
          <button className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-4 py-2 text-sm font-medium hover:bg-elevated">
            <RotateCcw className="h-4 w-4" /> Reset to Defaults
          </button>
          <button onClick={handleSave} className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90">
            <Save className="h-4 w-4" /> {saved ? 'Saved!' : 'Save Changes'}
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

          {/* Platform Settings */}
          <div className="card">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/15">
                <Settings className="h-5 w-5 text-brand" />
              </span>
              <div>
                <h3 className="font-semibold">Platform Settings</h3>
                <p className="text-xs text-muted">Configure basic information about your FamilyOS system.</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Platform Name</label>
                <input defaultValue="FamilyOS" className="w-full rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand/30" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Platform Tagline</label>
                <input defaultValue="A smarter way to manage your family" className="w-full rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand/30" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Default Timezone</label>
                <select className="w-full rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm outline-none">
                  <option>(UTC-05:00) Eastern Time (US &amp; Canada)</option>
                  <option>(UTC-06:00) Central Time</option>
                  <option>(UTC-07:00) Mountain Time</option>
                  <option>(UTC-08:00) Pacific Time</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Date Format</label>
                <select className="w-full rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm outline-none">
                  <option>May 14, 2024 (MMM DD, YYYY)</option>
                  <option>05/14/2024 (MM/DD/YYYY)</option>
                  <option>14/05/2024 (DD/MM/YYYY)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Time Format</label>
                <select className="w-full rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm outline-none">
                  <option>12-Hour (AM/PM)</option>
                  <option>24-Hour</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Week Starts On</label>
                <select className="w-full rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm outline-none">
                  <option>Sunday</option>
                  <option>Monday</option>
                </select>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between rounded-xl border border-border bg-surface/40 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Enable Maintenance Mode</p>
                <p className="text-xs text-muted">When enabled, only administrators can access the system.</p>
              </div>
              <Toggle defaultOn />
            </div>
          </div>

          {/* Security Settings */}
          <div className="card">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-success/15">
                <Shield className="h-5 w-5 text-success" />
              </span>
              <div>
                <h3 className="font-semibold">Security Settings</h3>
                <p className="text-xs text-muted">Configure security policies and session management.</p>
              </div>
            </div>
            <div className="space-y-0">
              <SettingRow label="Password Policy" desc="Enforce strong password requirements" value="Strong" valueColor="text-success" />
              <SettingRow label="Session Timeout" desc="Automatically log out inactive users" value="30 minutes" />
              <SettingRow label="Failed Login Attempts" desc="Lock account after failed attempts" value="5 attempts" />
              <div className="flex items-center justify-between py-3 border-b border-border/50">
                <div>
                  <p className="text-sm font-medium">Two-Factor Authentication (2FA)</p>
                  <p className="text-xs text-muted">Require 2FA for admin accounts</p>
                </div>
                <Toggle defaultOn />
              </div>
              <div className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium">IP Whitelisting</p>
                  <p className="text-xs text-muted">Restrict access to trusted IP addresses</p>
                </div>
                <Toggle />
              </div>
            </div>
          </div>

          {/* Storage & Data Settings */}
          <div className="card">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15">
                <Database className="h-5 w-5 text-indigo-400" />
              </span>
              <div>
                <h3 className="font-semibold">Storage &amp; Data Settings</h3>
                <p className="text-xs text-muted">Manage storage limits and data retention policies.</p>
              </div>
            </div>
            <div className="space-y-0">
              <SettingRow label="Total Storage Limit" desc="Maximum storage for the system" value="10 TB" />
              <SettingRow label="Data Retention Period" desc="How long to keep user data" value="2 years" />
              <SettingRow label="Auto Delete Inactive Accounts" desc="Automatically delete inactive accounts" value="Disabled" valueColor="text-warning" />
              <SettingRow label="Content Backup Frequency" desc="How often to backup content" value="Daily" />
            </div>
          </div>

          {/* Integrations Settings */}
          <div className="card">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning/15">
                <Puzzle className="h-5 w-5 text-warning" />
              </span>
              <div>
                <h3 className="font-semibold">Integrations Settings</h3>
                <p className="text-xs text-muted">Configure third-party integrations and services.</p>
              </div>
            </div>
            <div className="space-y-0">
              <SettingRow label="Payment Gateway" desc="Manage payment processors" value="Stripe (Active)" valueColor="text-success" />
              <SettingRow label="Email Service" desc="Configure email service provider" value="SendGrid (Active)" valueColor="text-success" />
              <SettingRow label="Cloud Storage" desc="Configure cloud storage provider" value="AWS S3 (Active)" valueColor="text-success" />
              <SettingRow label="Analytics" desc="Configure analytics and tracking" value="Google Analytics" valueColor="text-success" />
            </div>
            <button className="mt-3 text-xs text-brand hover:underline">Manage integrations →</button>
          </div>

          <p className="text-xs text-muted text-center">
            ℹ️ Changes made to settings may take a few minutes to apply across the system.
          </p>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Notification Settings */}
          <div className="card">
            <div className="mb-3 flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted" />
              <h3 className="font-semibold">Notification Settings</h3>
            </div>
            <p className="mb-3 text-xs text-muted">Manage system and email notifications.</p>
            <div className="space-y-3">
              {[
                { label: 'New User Registration', sub: 'Notify when a new user registers',         on: true },
                { label: 'Subscription Updates',  sub: 'Notify about subscription changes',        on: true },
                { label: 'Payment Notifications', sub: 'Notify for payment success or failure',    on: true },
                { label: 'Security Alerts',       sub: 'Notify about security events',             on: true },
                { label: 'System Alerts',         sub: 'Notify about system issues',               on: false },
              ].map((n) => (
                <div key={n.label} className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{n.label}</p>
                    <p className="text-xs text-muted">{n.sub}</p>
                  </div>
                  <Toggle defaultOn={n.on} />
                </div>
              ))}
            </div>
            <button className="mt-4 text-xs text-brand hover:underline">Manage email templates →</button>
          </div>

          {/* System Information */}
          <div className="card">
            <div className="mb-3 flex items-center gap-2">
              <Info className="h-4 w-4 text-brand" />
              <h3 className="font-semibold">System Information</h3>
            </div>
            <p className="mb-3 text-xs text-muted">View system details and environment information.</p>
            <div className="space-y-2 text-sm">
              {[
                { label: 'Current Version', value: 'v2.4.1' },
                { label: 'Environment',     value: 'Production' },
                { label: 'Server Region',   value: 'US East (N. Virginia)' },
                { label: 'Last Updated',    value: 'May 14, 2024 10:24 AM' },
              ].map((r) => (
                <div key={r.label} className="flex justify-between">
                  <span className="text-muted">{r.label}</span>
                  <span className="font-medium">{r.value}</span>
                </div>
              ))}
            </div>
            <button className="mt-4 text-xs text-brand hover:underline">View system health →</button>
          </div>

          {/* Danger Zone */}
          <div className="card border border-danger/30">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <h3 className="font-semibold">Danger Zone</h3>
            </div>
            <p className="mb-3 text-xs text-muted">Irreversible and sensitive actions.</p>
            <div className="rounded-xl border border-danger/40 bg-danger/10 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-danger">Clear System Cache</p>
                  <p className="text-xs text-muted">Clear cached data to improve performance</p>
                </div>
                <button className="rounded-lg p-1.5 text-danger hover:bg-danger/15">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <button className="mt-3 flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm hover:bg-elevated">
              <div>
                <p className="font-medium">Reset System Settings</p>
                <p className="text-xs text-muted">Reset all settings to default values</p>
              </div>
              <RotateCcw className="h-4 w-4 text-muted" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
