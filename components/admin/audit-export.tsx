'use client';
import { Download } from 'lucide-react';

export type AuditRow = { date: string; user: string; action: string; resource: string; status: string };

export function AuditExportButton({ rows }: { rows: AuditRow[] }) {
  function exportCsv() {
    const header = ['Date & Time', 'User', 'Action', 'Resource', 'Status'];
    const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
    const csv = [header.join(','), ...rows.map((r) => [r.date, r.user, r.action, r.resource, r.status].map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/40 px-3.5 py-2 text-sm font-medium hover:bg-elevated">
      <Download className="h-4 w-4" /> Export Logs
    </button>
  );
}
