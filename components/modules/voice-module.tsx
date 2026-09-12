'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, MicOff, Sparkles, CheckSquare, StickyNote, CalendarPlus, ShoppingCart,
  Send, RotateCcw, Trash2, Info, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useSpeechRecognition } from '@/lib/hooks/use-speech-recognition';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { CaptureSaveError, saveCapture, undoCapture, tableForKind } from '@/lib/capture/save';
import { useJourney } from '@/lib/analytics/use-journey';
import { classifyVoiceCommand, describeRoute } from '@/lib/voice/command-router';
import type { CaptureKind } from '@/lib/capture/parse';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type VoiceCommand = Tables<'voice_commands'>;

const KIND_META: Record<CaptureKind, { label: string; icon: typeof Mic; cls: string }> = {
  task: { label: 'Task', icon: CheckSquare, cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  note: { label: 'Note', icon: StickyNote, cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  event: { label: 'Event', icon: CalendarPlus, cls: 'text-blue-300 bg-blue-500/10 border-blue-500/30' },
  shopping: { label: 'Shopping', icon: ShoppingCart, cls: 'text-violet-300 bg-violet-500/10 border-violet-500/30' },
};

const EXAMPLES = [
  'Remind me to pay the water bill Friday',
  'Add milk and eggs to the shopping list',
  'Schedule dentist tomorrow at 3pm',
  'Note that the garage code is 1234',
];

/** Short relative time like "just now", "3m ago", "2h ago", "Jul 4". */
function ago(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const days = Math.round(s / 86400);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function VoiceModule() {
  const { familyId, userId } = useApp();
  return <VoiceCaptureSession key={JSON.stringify([familyId, userId])} />;
}

function VoiceCaptureSession() {
  const tr = useTranslations();
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const speech = useSpeechRecognition();
  const journey = useJourney('voice_command');
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [uncertainHref, setUncertainHref] = useState<string | null>(null);
  const operation = useRef({ mounted: true, pending: false, uncertain: false });
  useEffect(() => {
    const lifetime = operation.current;
    lifetime.mounted = true;
    return () => { lifetime.mounted = false; };
  }, []);

  // Mirror the recognized transcript into the editable field so the user can
  // tweak before running (and so unsupported browsers can type instead).
  useEffect(() => {
    if (speech.transcript && !operation.current.pending && !operation.current.uncertain) setText(speech.transcript);
  }, [speech.transcript]);

  const { data: history, loading, error, refresh } = useRealtimeQuery<VoiceCommand>({
    table: 'voice_commands', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('voice_commands').select('*').eq('family_id', familyId)
      .order('created_at', { ascending: false }).limit(20),
  });

  // Live routing preview for the current text.
  const preview = useMemo(() => {
    const t = text.trim();
    if (!t) return null;
    return classifyVoiceCommand(t);
  }, [text]);

  function toggleMic() {
    if (!operation.current.mounted || operation.current.pending || operation.current.uncertain) return;
    if (speech.listening) { speech.stop(); return; }
    setText('');
    speech.reset();
    speech.start();
  }

  async function run(commandText: string) {
    const raw = commandText.trim();
    const lifetime = operation.current;
    if (!raw || !lifetime.mounted || lifetime.pending || lifetime.uncertain) return;
    lifetime.pending = true;
    const isCurrent = () => lifetime.mounted && operation.current === lifetime && lifetime.pending;
    setRunning(true);
    const route = classifyVoiceCommand(raw);
    let sb: ReturnType<typeof createClient> | undefined;
    try {
      if (speech.listening) speech.stop();
      journey.start();
      if (!route.text) { journey.abandon(); toastError("Didn't catch a command — try again."); return; }
      sb = createClient();
      const res = await saveCapture(sb, {
        kind: route.kind, text: route.text, familyId, userId, memberId: selfMember?.id ?? null, isCurrent,
      });
      if (!isCurrent()) return;
      // Log the command to the family's voice history (best-effort — a logging
      // failure must not lose the thing we just created).
      try { void sb.from('voice_commands').insert({
        family_id: familyId, member_id: selfMember?.id ?? null, transcript: route.text,
        resolved_kind: route.kind, action_table: tableForKind(route.kind),
        action_count: res.count, status: 'routed', created_by: userId,
      }).then(() => {}, () => {}); } catch { /* capture is confirmed; history is best-effort */ }
      if (!isCurrent()) return;
      let undoState: 'ready' | 'pending' | 'done' | 'uncertain' = 'ready';
      success(
        `${describeRoute(route.kind)}${res.count > 1 ? ` · ${res.count} items` : ''}`,
        { label: 'Undo', onClick: async () => {
          if (undoState !== 'ready') return;
          undoState = 'pending';
          try {
            await undoCapture(createClient(), res.undo);
            undoState = 'done';
            success(tr('voiceModule.undone'));
          } catch (error) {
            undoState = error instanceof CaptureSaveError && error.outcome === 'uncertain' ? 'uncertain' : 'ready';
            toastError(tr('voiceModule.couldNotUndo'));
          }
        } },
      );
      journey.complete();
      setText('');
      speech.reset();
    } catch (err) {
      if (!isCurrent() || (err instanceof CaptureSaveError && err.outcome === 'retired')) return;
      if (err instanceof CaptureSaveError && err.outcome === 'uncertain') {
        lifetime.uncertain = true;
        setText(raw);
        setUncertainHref(err.href);
        toastError(tr('quickCapture.saveUncertain'));
        return;
      }
      journey.abandon();
      // Record the failed attempt so the history is honest.
      if (sb) try { void sb.from('voice_commands').insert({
        family_id: familyId, member_id: selfMember?.id ?? null, transcript: raw,
        resolved_kind: route.kind, status: 'failed', created_by: userId,
      }).select('id').then(() => {}, () => {}); } catch { /* preserve the original capture failure */ }
      if (isCurrent()) toastError(describeDbError(err, tr('voiceModule.couldNotRunThatCommand')));
    } finally {
      if (isCurrent()) setRunning(false);
      lifetime.pending = false;
    }
  }

  async function remove(c: VoiceCommand) {
    const sb = createClient();
    const { error: err } = await sb.from('voice_commands').delete().eq('id', c.id);
    if (err) toastError(describeDbError(err));
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title={tr('voice.voiceControl')}
        description={tr('voiceModule.speakACommandBubalyFiles')}
      />

      {/* Mic + transcript */}
      <div className="rounded-2xl border border-border bg-surface/50 p-5">
        <div className="flex flex-col items-center gap-3 py-2">
          <button
            onClick={toggleMic}
            disabled={!speech.supported || running || Boolean(uncertainHref)}
            aria-label={speech.listening ? 'Stop listening' : 'Start listening'}
            className={cn(
              'grid h-20 w-20 place-items-center rounded-full text-white shadow-glow transition active:scale-95 disabled:opacity-40',
              speech.listening ? 'animate-pulse bg-rose-500 hover:bg-rose-600' : 'bg-brand hover:brightness-110',
            )}
          >
            {speech.listening ? <MicOff className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
          </button>
          <p className="text-sm text-muted">
            {!speech.supported ? 'Voice input isn’t supported here — type your command below.'
              : speech.listening ? 'Listening… tap to stop.' : 'Tap the mic and speak, or type below.'}
          </p>
          {speech.error && <p className="text-sm text-rose-400">{speech.error}</p>}
        </div>

        <Textarea
          value={text}
          disabled={running || Boolean(uncertainHref)}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={tr('voice.eGRemindMeToPack')}
          className="mt-2"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(text); } }}
        />

        {/* Live routing preview */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="min-h-[1.75rem]">
            {preview?.text && (() => {
              const meta = KIND_META[preview.kind];
              const Icon = meta.icon;
              return (
                <span className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium', meta.cls)}>
                  <Icon className="h-3.5 w-3.5" /> {meta.label}
                  <span className="text-muted">· “{preview.text}”</span>
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-2">
            {text && <Button variant="ghost" disabled={running || Boolean(uncertainHref)} onClick={() => { setText(''); speech.reset(); }} className="gap-1"><RotateCcw className="h-4 w-4" /> {tr('voice.clear')}</Button>}
            <Button onClick={() => run(text)} disabled={!text.trim() || running || Boolean(uncertainHref)} className="gap-1.5">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {tr('voice.runCommand')}
            </Button>
          </div>
        </div>
        {uncertainHref && <p role="status" className="mt-3 text-sm text-muted">
          {tr('quickCapture.saveUncertain')}{' '}
          <a href={uncertainHref} className="underline">{tr('quickCapture.reviewCapture')}</a>
        </p>}
      </div>

      {/* Examples */}
      <div className="mt-4 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => setText(ex)} disabled={running || Boolean(uncertainHref)}
            className="rounded-lg border border-border bg-surface/50 px-2.5 py-1 text-xs text-muted transition hover:bg-elevated hover:text-fg">
            {ex}
          </button>
        ))}
      </div>

      {/* Recent commands */}
      <div className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
          <Sparkles className="h-4 w-4 text-brand-text" /> {tr('voice.recentCommands')}
        </h2>
        {loading ? (
          <SkeletonList count={3} />
        ) : error ? (
          <ErrorState message={tr('voiceModule.couldNotLoadVoiceHistory')} onRetry={refresh} />
        ) : (history ?? []).length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 p-4 text-sm text-muted">
            <Info className="h-4 w-4 shrink-0" /> {tr('voice.yourSpokenCommandsWillAppearHere')}
          </p>
        ) : (
          <ul className="space-y-2">
            {(history ?? []).map((c) => {
              const kind = (c.resolved_kind ?? 'note') as CaptureKind;
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              const failed = c.status === 'failed';
              return (
                <li key={c.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 p-3">
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg border', failed ? 'text-rose-300 bg-rose-500/10 border-rose-500/30' : meta.cls)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg">{c.transcript}</p>
                    <p className="text-xs text-muted">
                      {failed ? 'Failed' : describeRoute(kind)}{c.action_count > 1 ? ` · ${c.action_count} items` : ''} · {ago(c.created_at)}
                    </p>
                  </div>
                  <button onClick={() => run(c.transcript)} disabled={running || Boolean(uncertainHref)} aria-label={tr('voice.runAgain')} title={tr('voice.runAgain')}
                    className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-brand-text"><RotateCcw className="h-4 w-4" /></button>
                  <button onClick={() => remove(c)} aria-label={tr('voice.remove')} title={tr('voice.remove')}
                    className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
