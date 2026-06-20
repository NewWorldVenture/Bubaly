'use client';

import { useState } from 'react';
import {
  DollarSign, FileText, ShoppingCart, RotateCcw, AlertCircle,
  Download, Plus, TrendingUp, TrendingDown, ChevronRight,
  CreditCard, Building2, Wallet, MoreHorizontal
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const TABS = ['Overview', 'Transactions', 'Invoices', 'Plans & Pricing', 'Payment Methods', 'Refunds & Disputes', 'Tax Settings'];

const PLAN_DATA = [
  { name: 'Family Plus', revenue: 14920, pct: 52.3, color: '#8b5cf6' },
  { name: 'Premium',     revenue: 7860,  pct: 27.6, color: '#6366f1' },
  { name: 'Basic',       revenue: 3980,  pct: 13.9, color: '#22c55e' },
  { name: 'Free',        revenue: 1200,  pct: 4.2,  color: '#f59e0b' },
  { name: 'Other',       revenue: 580,   pct: 2.0,  color: '#6b7280' },
];

const PAYMENT_METHODS = [
  { name: 'Credit Card',   count: 842,  pct: 67.6, color: '#8b5cf6' },
  { name: 'PayPal',        count: 268,  pct: 21.5, color: '#6366f1' },
  { name: 'Bank Transfer', count: 98,   pct: 7.9,  color: '#22c55e' },
  { name: 'Other',         count: 40,   pct: 3.0,  color: '#f59e0b' },
];

const TRANSACTIONS = [
  { id: 'TXN-2024-0514-001', date: 'May 14, 2024 10:24 AM', customer: 'Johnson Family', plan: 'Family Plus', amount: 14.99, method: 'VISA ···· 4242', status: 'Completed' },
  { id: 'TXN-2024-0514-002', date: 'May 14, 2024 09:15 AM', customer: 'Smith Family',   plan: 'Premium',    amount: 9.99,  method: 'MC ···· 8888',  status: 'Completed' },
  { id: 'TXN-2024-0513-001', date: 'May 13, 2024 08:42 PM', customer: 'Davis Family',   plan: 'Family Plus', amount: 14.99, method: 'VISA ···· 1234', status: 'Completed' },
  { id: 'TXN-2024-0513-002', date: 'May 13, 2024 07:30 PM', customer: 'Brown Family',   plan: 'Premium',    amount: 9.99,  method: 'PayPal',       status: 'Completed' },
  { id: 'TXN-2024-0512-001', date: 'May 12, 2024 06:18 PM', customer: 'Williams Family',plan: 'Family Plus', amount: 14.99, method: 'VISA ···· 5555', status: 'Completed' },
];

const INVOICES = [
  { id: 'INV-2024-0514', customer: 'Johnson Family', date: 'May 14, 2024', amount: 14.99, status: 'Paid' },
  { id: 'INV-2024-0513', customer: 'Smith Family',   date: 'May 13, 2024', amount: 9.99,  status: 'Paid' },
  { id: 'INV-2024-0512', customer: 'Davis Family',   date: 'May 12, 2024', amount: 14.99, status: 'Paid' },
  { id: 'INV-2024-0511', customer: 'Brown Family',   date: 'May 11, 2024', amount: 9.99,  status: 'Pending' },
  { id: 'INV-2024-0510', customer: 'Williams Family',date: 'May 10, 2024', amount: 14.99, status: 'Paid' },
];

// Sparkline-style revenue chart data points (normalized 0–1)
const CHART_POINTS = [0.45,0.48,0.44,0.50,0.52,0.49,0.55,0.58,0.53,0.60,0.62,0.59,0.65,0.63,0.68,0.66,0.70,0.72,0.69,0.74,0.71,0.76,0.73,0.78,0.80,0.77,0.82,0.79,0.85,0.88];
const CHART_LABELS = ['Apr 15','Apr 20','Apr 25','Apr 30','May 5','May 10','May 14'];

function DonutChart({ data, centerLabel, centerValue }: {
  data: { name: string; pct: number; color: string }[];
  centerLabel: string;
  centerValue: string;
}) {
  let offset = 0;
  const r = 40, circ = 2 * Math.PI * r;
  return (
    <div className="relative flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 100 100" className="rotate-[-90deg]">
          {data.map((d) => {
            const dash = (d.pct / 100) * circ;
            const gap = circ - dash;
            const el = (
              <circle key={d.name} cx="50" cy="50" r={r}
                fill="none" stroke={d.color} strokeWidth="16"
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={-offset * circ / 100}
              />
            );
            offset += d.pct;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-base font-bold">{centerValue}</span>
          <span className="text-[10px] text-muted">{centerLabel}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
            <span className="text-muted">{d.name}</span>
            <span className="ml-auto font-medium">{d.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineChart() {
  const h = 120, w = 460, pad = { t: 10, b: 30, l: 40, r: 10 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const n = CHART_POINTS.length;
  const pts = CHART_POINTS.map((v, i) => ({
    x: pad.l + (i / (n - 1)) * plotW,
    y: pad.t + (1 - v) * plotH,
  }));
  const polyline = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const area = `M${pts[0].x},${h - pad.b} ` + pts.map((p) => `L${p.x},${p.y}`).join(' ') + ` L${pts[n-1].x},${h - pad.b} Z`;
  const yLabels = ['$0','$10K','$20K','$30K','$40K'];
  const xLabels = CHART_LABELS;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full min-w-[300px]" style={{ minHeight: 100 }}>
        <defs>
          <linearGradient id="chartGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {yLabels.map((l, i) => {
          const y = pad.t + ((4 - i) / 4) * plotH;
          return <g key={l}>
            <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
            <text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize="9" fill="currentColor" fillOpacity="0.45">{l}</text>
          </g>;
        })}
        {xLabels.map((l, i) => {
          const x = pad.l + (i / (xLabels.length - 1)) * plotW;
          return <text key={l} x={x} y={h - 4} textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.45">{l}</text>;
        })}
        <path d={area} fill="url(#chartGrad)" />
        <polyline points={polyline} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export default function AdminBillingPage() {
  const [tab, setTab] = useState('Overview');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Billing &amp; Payments</h1>
          <p className="text-sm text-muted">Manage billing, payments, invoices, and financial transactions.</p>
        </div>
        <div className="flex gap-2">
          <button className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-4 py-2 text-sm font-medium hover:bg-elevated">
            <Download className="h-4 w-4" /> Download Statement
          </button>
          <button className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90">
            <Plus className="h-4 w-4" /> Create Invoice
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
          {/* Stat cards */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {[
              { label: 'Total Revenue',      value: '$28,540', icon: DollarSign, delta: '+12.4%', up: true,  color: 'text-success' },
              { label: 'MRR',                value: '$24,860', icon: FileText,   delta: '+8.7%',  up: true,  color: 'text-brand' },
              { label: 'Total Transactions', value: '1,248',   icon: ShoppingCart,delta:'+10.2%', up: true,  color: 'text-indigo-400' },
              { label: 'Refunds',            value: '$720',    icon: RotateCcw,  delta: '-4.3%',  up: false, color: 'text-warning' },
              { label: 'Failed Payments',    value: '23',      icon: AlertCircle,delta: '-15.6%', up: false, color: 'text-danger' },
            ].map((s) => (
              <div key={s.label} className="card flex items-start gap-3">
                <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface/80', s.color)}>
                  <s.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className="text-xl font-bold">{s.value}</p>
                  <p className={cn('text-xs', s.up ? 'text-success' : 'text-danger')}>
                    {s.up ? <TrendingUp className="mr-0.5 inline h-3 w-3" /> : <TrendingDown className="mr-0.5 inline h-3 w-3" />}
                    {s.delta} vs last 30 days
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Charts row */}
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Revenue Over Time */}
            <div className="card lg:col-span-1">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold">Revenue Over Time</h3>
                <select className="rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs">
                  <option>Last 30 Days</option>
                  <option>Last 90 Days</option>
                </select>
              </div>
              <p className="text-2xl font-bold">$28,540</p>
              <p className="mb-3 text-xs text-success">+12.4% vs Apr 14 - Apr 15</p>
              <LineChart />
            </div>

            {/* Revenue by Plan */}
            <div className="card">
              <h3 className="mb-4 font-semibold">Revenue by Plan</h3>
              <DonutChart data={PLAN_DATA} centerLabel="Total Revenue" centerValue="$28,540" />
            </div>

            {/* Payment Methods */}
            <div className="card">
              <h3 className="mb-4 font-semibold">Payment Methods</h3>
              <DonutChart
                data={PAYMENT_METHODS.map((m) => ({ ...m, name: m.name }))}
                centerLabel="Transactions"
                centerValue="1,248"
              />
              <button className="mt-4 text-xs text-brand hover:underline">View all payment methods →</button>
            </div>
          </div>

          {/* Recent Transactions */}
          <div className="card">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold">Recent Transactions</h3>
              <button className="text-xs text-brand hover:underline">View all transactions →</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    {['Transaction ID','Date','Customer / Family','Plan','Amount','Payment Method','Status'].map((h) => (
                      <th key={h} className="pb-2 pr-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {TRANSACTIONS.map((tx) => (
                    <tr key={tx.id} className="text-sm">
                      <td className="py-3 pr-4 font-mono text-xs text-muted">{tx.id}</td>
                      <td className="py-3 pr-4 text-xs text-muted whitespace-nowrap">{tx.date}</td>
                      <td className="py-3 pr-4 font-medium">{tx.customer}</td>
                      <td className="py-3 pr-4 text-muted">{tx.plan}</td>
                      <td className="py-3 pr-4 font-semibold">${tx.amount.toFixed(2)}</td>
                      <td className="py-3 pr-4 text-xs text-muted">{tx.method}</td>
                      <td className="py-3">
                        <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">{tx.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center justify-between text-xs text-muted">
              <span>Showing 1 to 5 of 1,248 transactions</span>
              <div className="flex items-center gap-1">
                {[1,2,3,'…',250].map((p) => (
                  <button key={p} className={cn('h-7 min-w-7 rounded-lg px-2 text-xs', p === 1 ? 'bg-brand text-white' : 'hover:bg-elevated')}>{p}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Billing Summary */}
          <div className="card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">Billing Summary</h3>
              <select className="rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs">
                <option>This Month</option>
              </select>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Total Billed',    value: '$28,540', dot: 'bg-success' },
                { label: 'Total Collected', value: '$26,820', dot: 'bg-success' },
                { label: 'Outstanding',     value: '$1,720',  dot: 'bg-warning' },
                { label: 'Overdue',         value: '$420',    dot: 'bg-danger' },
              ].map((r) => (
                <div key={r.label} className="flex items-center gap-2">
                  <span className={cn('h-2.5 w-2.5 rounded-full', r.dot)} />
                  <span className="flex-1 text-sm text-muted">{r.label}</span>
                  <span className="text-sm font-semibold">{r.value}</span>
                </div>
              ))}
            </div>
            <button className="mt-4 text-xs text-brand hover:underline">View full summary →</button>
          </div>

          {/* Recent Invoices */}
          <div className="card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">Recent Invoices</h3>
              <button className="text-xs text-brand hover:underline">View all</button>
            </div>
            <div className="space-y-3">
              {INVOICES.map((inv) => (
                <div key={inv.id} className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/15">
                    <FileText className="h-4 w-4 text-brand" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-mono text-muted">{inv.id}</p>
                    <p className="truncate text-sm font-medium">{inv.customer}</p>
                    <p className="text-xs text-muted">{inv.date}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">${inv.amount.toFixed(2)}</p>
                    <span className={cn('text-xs font-medium', inv.status === 'Paid' ? 'text-success' : 'text-warning')}>{inv.status}</span>
                  </div>
                </div>
              ))}
            </div>
            <button className="mt-4 text-xs text-brand hover:underline">View all invoices →</button>
          </div>

          {/* Quick Actions */}
          <div className="card">
            <h3 className="mb-3 font-semibold">Quick Actions</h3>
            <div className="space-y-1">
              {[
                { label: 'Create Invoice',         icon: FileText },
                { label: 'Record Payment',         icon: CreditCard },
                { label: 'Issue Refund',           icon: RotateCcw },
                { label: 'Manage Payment Methods', icon: Wallet },
                { label: 'View Billing Settings',  icon: Building2 },
              ].map((a) => (
                <button key={a.label} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-elevated">
                  <a.icon className="h-4 w-4 text-muted" />
                  <span className="flex-1 text-left">{a.label}</span>
                  <ChevronRight className="h-4 w-4 text-muted" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
