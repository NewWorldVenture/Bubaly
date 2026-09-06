'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const lines = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsToolbar({ userRows, familyRows, contentRows }: {
  userRows: (string | number)[][];
  familyRows: (string | number)[][];
  contentRows: (string | number)[][];
}) {
  const t = useTranslations();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Button variant="secondary" size="sm" onClick={() => downloadCsv(`user-activity-${today}.csv`, ['Name', 'Email', 'Family', 'Role', 'Joined'], userRows)}>
        <Download className="h-4 w-4" /> {t('reportsToolbar.userActivityReport')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => downloadCsv(`subscription-revenue-${today}.csv`, ['Family', 'Plan', 'Status', 'Created'], familyRows)}>
        <Download className="h-4 w-4" /> {t('reportsToolbar.subscriptionRevenueReport')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => downloadCsv(`content-engagement-${today}.csv`, ['Title', 'Family', 'Category', 'Size', 'Added'], contentRows)}>
        <Download className="h-4 w-4" /> {t('reportsToolbar.contentReport')}
      </Button>
    </div>
  );
}
