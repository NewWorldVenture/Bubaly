'use client';

import { useRouter } from 'next/navigation';
import { useLayoutEffect, useState, useRef } from 'react';
import {
  Mic, Type, Camera, FileText, Sparkles, X, ArrowRight,
  Loader2, ChevronDown, Undo2,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toast';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { CaptureSaveError, saveCapture, undoCapture, type CaptureSaveResult } from '@/lib/capture/save';
import type { CaptureKind } from '@/lib/capture/parse';
import { CaptureShortcuts } from '@/components/capture/capture-shortcuts';
import { describeDbError } from '@/lib/supabase/errors';
import { useTranslations } from '@/components/i18n/locale-provider';
import { DocumentCapture } from '@/components/capture/document-capture';
import { documentLinkCandidates } from '@/lib/capture/document-link';

type CaptureMode = 'type' | 'voice' | 'photo' | 'document';

// Routed destinations that we can create directly (the rest just navigate).
const URL_TO_KIND: Record<string, CaptureKind> = {
  '/dashboard/grocery': 'shopping',
  '/dashboard/calendar': 'event',
  '/dashboard/notes': 'note',
  '/dashboard/chores': 'task',
};

function routeCapture(text: string): { destination: string; url: string } {
  const lower = text.toLowerCase();
  if (/buy|shop|grocery|groceries|store|milk|eggs|bread|chicken|produce/.test(lower))
    return { destination: 'Grocery List', url: '/dashboard/grocery' };
  if (/event|party|birthday|meeting|appointment|schedule|doctor|dentist|school/.test(lower))
    return { destination: 'Calendar', url: '/dashboard/calendar' };
  if (/meal|recipe|dinner|lunch|breakfast|cook|food/.test(lower))
    return { destination: 'Meals', url: '/dashboard/meals' };
  if (/trip|vacation|travel|flight|hotel|pack/.test(lower))
    return { destination: 'Trip Planner', url: '/dashboard/trips' };
  if (/health|symptom|medicine|medication|sick|pain|fever/.test(lower))
    return { destination: 'Health', url: '/dashboard/health' };
  if (/document|scan|file|pdf|receipt|invoice/.test(lower))
    return { destination: 'Documents', url: '/dashboard/documents' };
  if (/note|remember|idea|thought/.test(lower))
    return { destination: 'Notes', url: '/dashboard/notes' };
  if (/task|todo|remind|chore|clean|fix|repair|do|finish/.test(lower))
    return { destination: 'Tasks & Chores', url: '/dashboard/chores' };
  return { destination: 'AI Assistant', url: `/dashboard/assistant?q=${encodeURIComponent(text)}` };
}

export function CaptureShell({ initialShortcuts = null, initialText = '' }: {
  initialShortcuts?: string[] | null;
  /**
   * Prefilled from the PWA share target's query params (see
   * `lib/capture/share.ts`). Server-composed so a share that cold-starts the
   * app shows the shared text on the first paint.
   */
  initialText?: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { error: toastError, success } = useToast();
  const { familyId, userId, selfMember } = useApp();
  const [mode, setMode] = useState<CaptureMode>('type');
  const [text, setText] = useState(initialText);
  const [routing, setRouting] = useState(false);
  const [routed, setRouted] = useState<{ destination: string; url: string } | null>(null);
  const [created, setCreated] = useState<(CaptureSaveResult & { destination: string }) | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [reviewHref, setReviewHref] = useState<string | null>(null);
  const [intent, setIntent] = useState(0);
  const owner = JSON.stringify([familyId, userId, selfMember?.id ?? null]);
  const lifetime = useRef({ mounted: false, owner, intent: 0, pending: null as object | null, settled: false, review: false });
  const textRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const current = lifetime.current;
    current.mounted = true; current.owner = owner; current.pending = null;
    current.settled = false; current.review = false;
    setIntent(++current.intent);
    setText(initialText); setRouting(false); setUndoing(false); setCreated(null); setRouted(null); setReviewHref(null); setRecording(false);
    return () => { current.mounted = false; current.intent++; current.pending = null; };
  }, [owner, initialText]);

  function isCurrent() {
    const current = lifetime.current;
    return current.mounted && current.owner === owner && current.intent === intent;
  }

  function nextIntent() {
    lifetime.current.settled = false;
    setIntent(++lifetime.current.intent);
  }

  // One-tap undo: delete the rows the capture just created and restore the input
  // so the user can edit and re-file, or walk away. Frictionless safety net for
  // a mis-routed capture.
  async function undoCreated() {
    if (!created || !isCurrent() || lifetime.current.pending || lifetime.current.review) return;
    const attempt = {};
    lifetime.current.pending = attempt;
    setUndoing(true);
    try {
      await undoCapture(createClient(), created.undo, { isCurrent: () => isCurrent() && lifetime.current.pending === attempt });
      if (!isCurrent()) return;
      const restore = text || created.title;
      success(t('captureShell.undone'));
      nextIntent();
      setCreated(null);
      setText(restore);
      setMode('type');
      textRef.current?.focus();
    } catch (err) {
      if (!isCurrent()) return;
      // A failed or unconfirmed Undo is reviewed at the original destination;
      // a retained callback must not issue the same delete again.
      lifetime.current.review = true;
      setReviewHref(created.href);
      toastError(describeDbError(err, t('captureShell.couldNotUndo')));
    } finally {
      const current = lifetime.current;
      if (current.mounted && current.owner === owner && current.pending === attempt) {
        current.pending = null; setUndoing(false);
      }
    }
  }

  function handleInput(value: string) {
    if (!isCurrent() || lifetime.current.pending || lifetime.current.review) return;
    nextIntent();
    setText(value);
    setRouted(null);
    setCreated(null);
  }

  async function handleSubmit() {
    const value = text.trim();
    if (!value || !familyId || !userId || !isCurrent() || lifetime.current.pending || lifetime.current.settled || lifetime.current.review) return;
    const attempt = {};
    lifetime.current.pending = attempt;
    setRouting(true);
    const route = routeCapture(value);
    const kind = URL_TO_KIND[route.url];
    // When the routed destination is something we can create directly, capture
    // it for real (with natural-language times / due dates / multi-item lists)
    // instead of just navigating to an empty page.
    if (kind) {
      try {
        const res = await saveCapture(createClient(), { kind, text: value, familyId, userId, memberId: selfMember?.id ?? null, isCurrent: () => isCurrent() && lifetime.current.pending === attempt });
        if (!isCurrent()) return;
        lifetime.current.settled = true;
        setCreated({ ...res, destination: route.destination });
      } catch (err) {
        if (!isCurrent()) return;
        if (err instanceof CaptureSaveError && err.outcome === 'retired') return;
        if (err instanceof CaptureSaveError && err.outcome === 'uncertain') {
          lifetime.current.review = true;
          setReviewHref(err.href);
        } else {
          toastError(describeDbError(err, t('captureShell.couldNotSave')));
        }
      } finally {
        const current = lifetime.current;
        if (current.mounted && current.owner === owner && current.pending === attempt) {
          current.pending = null; setRouting(false);
        }
      }
      return;
    }
    setRouted(route);
    lifetime.current.pending = null;
    lifetime.current.settled = true;
    setRouting(false);
  }

  function goToDestination() {
    if (!isCurrent() || lifetime.current.pending) return;
    if (created) router.push(created.href);
    else if (routed) router.push(routed.url);
  }

  function captureAnother() {
    if (!isCurrent() || lifetime.current.pending || lifetime.current.review) return;
    nextIntent();
    setCreated(null);
    setText('');
    setMode('type');
    textRef.current?.focus();
  }

  function startVoice() {
    if (!isCurrent() || lifetime.current.pending || lifetime.current.review) return;
    type SpeechResult = { transcript: string };
    type SRCtor = new () => {
      lang: string; interimResults: boolean;
      onresult: ((e: { results: SpeechResult[][] }) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    const w = window as unknown as Record<string, unknown>;
    const SR: SRCtor | undefined = (w['SpeechRecognition'] ?? w['webkitSpeechRecognition']) as SRCtor | undefined;
    if (!SR) { toastError(t('captureShell.voiceInputIsNotSupported')); return; }
    const recognition = new SR();
    const voiceIntent = ++lifetime.current.intent;
    setIntent(voiceIntent);
    const isVoiceCurrent = () => lifetime.current.mounted && lifetime.current.owner === owner && lifetime.current.intent === voiceIntent;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    setMode('voice');
    setRecording(true);
    recognition.onresult = (e) => {
      if (!isVoiceCurrent()) return;
      const transcript = e.results[0]?.[0]?.transcript ?? '';
      nextIntent(); setText(transcript); setRouted(null); setCreated(null);
      setRecording(false);
      setMode('type');
    };
    recognition.onerror = () => { if (isVoiceCurrent()) { setRecording(false); toastError(t('captureShell.couldNotCaptureVoiceTry')); } };
    recognition.onend = () => { if (isVoiceCurrent()) setRecording(false); };
    recognition.start();
  }

  function switchMode(next: CaptureMode) {
    if (!isCurrent() || lifetime.current.pending || lifetime.current.review) return;
    if (next === 'voice') { startVoice(); return; }
    // A hidden text form and an old speech result cannot submit/change the
    // replacement mode. Existing confirmed receipts remain settled.
    setIntent(++lifetime.current.intent);
    setRecording(false); setMode(next);
    if (next === 'type') textRef.current?.focus();
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-24 pt-4">
      <div className="mx-auto w-full max-w-lg px-4">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t('captureShell.capture')}</h1>
            <p className="text-sm text-muted">{t('captureShell.speakTypeOrSnapAiRoutes')}</p>
          </div>
          <button type="button" disabled={routing || undoing} onClick={() => { if (isCurrent() && !lifetime.current.pending) { nextIntent(); router.back(); } }}
            className="grid h-9 w-9 place-items-center rounded-full bg-elevated text-muted hover:text-fg">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mode picker */}
        <div className="mb-4 grid grid-cols-4 gap-2">
          {([
            { id: 'type' as const, icon: Type, label: 'Type' },
            { id: 'voice' as const, icon: Mic, label: 'Voice' },
            { id: 'photo' as const, icon: Camera, label: 'Photo' },
            { id: 'document' as const, icon: FileText, label: 'Scan' },
          ]).map(({ id, icon: Icon, label }) => (
            <button key={id} type="button" disabled={routing || undoing || !!reviewHref} onClick={() => switchMode(id)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-2xl py-3 text-xs font-semibold transition',
                mode === id ? 'bg-brand/15 text-brand-text' : 'bg-elevated text-muted hover:bg-elevated/80 hover:text-fg',
              )}>
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </div>

        <a className="mb-4 block text-sm text-brand-text underline" href={`/capture/link?url=${encodeURIComponent(documentLinkCandidates(text)[0] ?? '')}`}>{t('documentLink.title')}</a>
        {mode === 'photo' || mode === 'document' ? <DocumentCapture photo={mode === 'photo'} /> : <>
        {/* Input area */}
        <div className="relative mb-4 overflow-hidden rounded-2xl border border-border bg-surface/40 focus-within:border-brand/50 focus-within:ring-1 focus-within:ring-brand/30">
          {recording ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-3 p-6">
              <div className="relative">
                <Mic className="h-10 w-10 text-brand-text" />
                <span className="absolute inset-0 animate-ping rounded-full bg-brand/30" />
              </div>
              <p className="text-sm font-medium text-brand-text">Listening…</p>
              <button type="button" onClick={() => { if (isCurrent()) { nextIntent(); setRecording(false); } }} className="text-xs text-muted underline">{t('captureShell.cancel')}</button>
            </div>
          ) : (
            <textarea
              ref={textRef}
              value={text}
              disabled={routing || undoing || !!reviewHref}
              onChange={(e) => handleInput(e.target.value)}
              placeholder={'What\'s on your mind? "Buy milk", "Plan birthday party", "Schedule dentist"…'}
              className="min-h-[120px] w-full resize-none bg-transparent p-4 text-sm outline-none placeholder:text-muted"
              autoFocus={mode === 'type'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
            />
          )}
          {text && !recording && (
            <div className="flex items-center justify-between border-t border-border/60 px-4 py-2">
              <span className="text-xs text-muted">{text.length} chars</span>
              <button type="button" disabled={routing || undoing || !!reviewHref} onClick={() => handleInput('')} className="text-xs text-muted hover:text-fg">{t('captureShell.clear')}</button>
            </div>
          )}
        </div>

        {reviewHref && (
          <div role="alert" className="mb-4 space-y-2 rounded-xl border border-border bg-elevated p-3 text-sm">
            <p>{created ? t('captureShell.couldNotUndo') : t('quickCapture.saveUncertain')}</p>
            <a className="font-medium text-brand-text underline" href={reviewHref}>{t('quickCapture.reviewCapture')}</a>
          </div>
        )}

        {/* Created confirmation */}
        {created ? (
          <div className="mb-4 overflow-hidden rounded-2xl border border-emerald-500/30 bg-emerald-500/5">
            <div className="flex items-center gap-3 p-4">
              <Sparkles className="h-5 w-5 shrink-0 text-emerald-500" />
              <div className="flex-1">
                <p className="text-sm font-semibold">
                  {created.count > 1 ? `Added ${created.count} items` : 'Added'} to <span className="text-emerald-600">{created.destination}</span>
                </p>
                {created.title && <p className="truncate text-xs text-muted">{created.title}</p>}
              </div>
              <button type="button" onClick={undoCreated} disabled={undoing || !!reviewHref}
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-elevated hover:text-fg disabled:opacity-60">
                {undoing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} {t('captureShell.undo')}
              </button>
            </div>
            <div className="flex gap-2 border-t border-emerald-500/20 p-3">
              <button type="button" onClick={goToDestination} disabled={undoing}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600/90">
                {t('captureShell.viewIn')} {created.destination} <ArrowRight className="h-4 w-4" />
              </button>
              <button type="button" onClick={captureAnother} disabled={undoing || !!reviewHref}
                className="flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-elevated">
                {t('captureShell.captureAnother')}
              </button>
            </div>
          </div>
        ) : routed ? (
          <div className="mb-4 overflow-hidden rounded-2xl border border-brand/30 bg-brand/5">
            <div className="flex items-center gap-3 p-4">
              <Sparkles className="h-5 w-5 shrink-0 text-brand-text" />
              <div className="flex-1">
                <p className="text-sm font-semibold">{t('captureShell.sendingTo')} <span className="text-brand-text">{routed.destination}</span></p>
                <p className="text-xs text-muted">{t('captureShell.aiMatchedYourInputToThe')}</p>
              </div>
            </div>
            <div className="flex gap-2 border-t border-brand/20 p-3">
              <button type="button" onClick={goToDestination}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90">
                {t('captureShell.goTo')} {routed.destination} <ArrowRight className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => { if (isCurrent() && !lifetime.current.pending) { nextIntent(); setRouted(null); } }}
                className="flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-elevated">
                <ChevronDown className="h-4 w-4" /> {t('captureShell.change')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" disabled={!text.trim() || routing || !!reviewHref} onClick={handleSubmit}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-sm font-bold text-white transition hover:bg-brand/90 disabled:opacity-40">
            {routing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
            {routing ? 'Capturing…' : 'Capture with AI'}
          </button>
        )}

        </>}

        {/* Quick route shortcuts — the member's own picks; customize to edit.
            Shared component = identical behavior in the Quick-capture modal. */}
        <CaptureShortcuts initialKeys={initialShortcuts} heading={t('captureShell.orJumpDirectlyTo')} columns={3} />
      </div>
    </div>
  );
}
