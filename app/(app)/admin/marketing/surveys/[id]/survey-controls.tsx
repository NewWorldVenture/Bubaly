'use client';

import { useState, useTransition } from 'react';
import { Play, Square, FileEdit, Copy, Check, Trash2, Loader2 } from 'lucide-react';
import { setSurveyStatusAction, deleteSurveyAction } from '../actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function SurveyControls({ id, status, publicUrl }: { id: string; status: string; publicUrl: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);

  const setStatus = (s: 'draft' | 'active' | 'closed') => start(async () => { await setSurveyStatusAction(id, s); });

  async function copy() {
    try { await navigator.clipboard.writeText(publicUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== 'active' && (
        <button onClick={() => setStatus('active')} disabled={pending} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-success px-3 text-sm font-medium text-white disabled:opacity-60">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {t('adminMarketingSurveysSurveyControls.activate')}
        </button>
      )}
      {status === 'active' && (
        <button onClick={() => setStatus('closed')} disabled={pending} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-warning px-3 text-sm font-medium text-white disabled:opacity-60">
          <Square className="h-4 w-4" /> {t('adminMarketingSurveysSurveyControls.close')}
        </button>
      )}
      {status !== 'draft' && (
        <button onClick={() => setStatus('draft')} disabled={pending} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-elevated disabled:opacity-60">
          <FileEdit className="h-4 w-4" /> {t('adminMarketingSurveysSurveyControls.backToDraft')}
        </button>
      )}
      <button onClick={copy} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-elevated">
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy share link'}
      </button>
      <button
        onClick={() => { if (confirm(t('surveyControls.deleteThisSurveyAndIts'))) start(async () => { await deleteSurveyAction(id); }); }}
        disabled={pending}
        className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted hover:text-danger"
      >
        <Trash2 className="h-4 w-4" /> {t('adminMarketingSurveysSurveyControls.delete')}
      </button>
    </div>
  );
}
