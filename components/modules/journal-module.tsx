'use client';

// Personal Journal — private reflection + growth. Dated entries with a mood, an
// AI/evergreen reflection prompt, and hands-free Voice Capture in the composer.
// 100% Supabase-wired via `journal_entries`, scoped to the signed-in member.
import { useMemo, useState } from 'react';
import {
  BookHeart, Plus, Trash2, Pencil, X, Sparkles, Mic, MicOff, Quote,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { promptOfTheDay } from '@/lib/journal/prompts';
import { useSpeechRecognition } from '@/lib/hooks/use-speech-recognition';
import { appendTranscript } from '@/lib/voice/transcript';
import { useTranslations } from '@/components/i18n/locale-provider';

type Entry = Tables<'journal_entries'>;
type Mood = NonNullable<Entry['mood']>;

const MOODS: { id: Mood; emoji: string; label: string }[] = [
  { id: 'great', emoji: '😄', label: 'Great' },
  { id: 'good', emoji: '🙂', label: 'Good' },
  { id: 'okay', emoji: '😐', label: 'Okay' },
  { id: 'low', emoji: '😔', label: 'Low' },
  { id: 'stressed', emoji: '😣', label: 'Stressed' },
];
const moodOf = (id: string | null) => MOODS.find((m) => m.id === id);

export function JournalModule() {
  const t = useTranslations();
  const { familyId, userId, selfMember } = useApp();
  const memberId = selfMember?.id ?? null;
  const { success, error: toastError } = useToast();
  const [composer, setComposer] = useState<{ entry: Entry | null; prompt: string | null } | null>(null);

  const { data, loading, error, refresh } = useRealtimeQuery<Entry>({
    table: 'journal_entries',
    familyId,
    deps: [familyId, memberId],
    fetcher: (supabase) =>
      supabase.from('journal_entries').select('*').eq('family_id', familyId)
        .eq('member_id', memberId ?? '').order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
  });

  async function remove(id: string) {
    const supabase = createClient();
    const { error: delErr } = await supabase.from('journal_entries').delete().eq('id', id);
    if (delErr) return toastError(describeDbError(delErr));
    success(t('journalModule.entryDeleted'));
    void refresh();
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={t('journal.journal')}
        description={t('journalModule.aPrivateSpaceToReflect')}
        action={<Button onClick={() => setComposer({ entry: null, prompt: null })}><Plus className="h-4 w-4" /> {t('journal.newEntry')}</Button>}
      />

      <PromptCard onWrite={(prompt) => setComposer({ entry: null, prompt })} />

      {data.length === 0 ? (
        <EmptyState icon={BookHeart} title={t('journal.yourJournalIsEmpty')}
          description={t('journalModule.reflectionBuildsSelfAwarenessStart')}
          action={<Button onClick={() => setComposer({ entry: null, prompt: null })}><Plus className="h-4 w-4" /> {t('journal.writeYourFirstEntry')}</Button>} />
      ) : (
        <div className="space-y-3">
          {data.map((e) => {
            const m = moodOf(e.mood);
            return (
              <div key={e.id} className="group rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {m && <span className="text-lg" title={m.label}>{m.emoji}</span>}
                    <div>
                      <p className="text-sm font-semibold">{e.title || fmtDate(e.entry_date)}</p>
                      <p className="text-[11px] text-muted">{fmtDate(e.entry_date)}</p>
                    </div>
                  </div>
                  <div className="flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <button onClick={() => setComposer({ entry: e, prompt: e.prompt })} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => { if (confirm(t('journalModule.deleteThisEntry'))) remove(e.id); }} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                {e.prompt && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs italic text-muted">
                    <Quote className="mt-0.5 h-3 w-3 flex-shrink-0" /> {e.prompt}
                  </p>
                )}
                {e.body && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{e.body}</p>}
              </div>
            );
          })}
        </div>
      )}

      {composer && (
        <EntryModal entry={composer.entry} initialPrompt={composer.prompt}
          familyId={familyId} userId={userId} memberId={memberId}
          onClose={() => setComposer(null)}
          onSaved={() => { setComposer(null); void refresh(); }} />
      )}
    </div>
  );
}

function PromptCard({ onWrite }: { onWrite: (prompt: string) => void }) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [prompt, setPrompt] = useState(promptOfTheDay());
  const [loading, setLoading] = useState(false);

  async function personalize() {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/journal', { method: 'POST' });
      const json = (await res.json()) as { prompt?: string; error?: string };
      if (!res.ok || !json.prompt) throw new Error(json.error || 'Could not get a prompt');
      setPrompt(json.prompt);
    } catch (err) {
      toastError(describeDbError(err, 'Could not get a prompt'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-5 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-text">
        <Sparkles className="h-3.5 w-3.5" /> {t('journal.todayAposSReflection')}
      </div>
      <p className="mt-2 text-base font-semibold leading-relaxed">{prompt}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={() => onWrite(prompt)}><Pencil className="h-4 w-4" /> {t('journal.writeAboutThis')}</Button>
        <Button variant="ghost" onClick={personalize} loading={loading}>
          <Sparkles className="h-4 w-4" /> {t('journal.personalize')}
        </Button>
      </div>
    </div>
  );
}

function EntryModal({ entry, initialPrompt, familyId, userId, memberId, onClose, onSaved }: {
  entry: Entry | null; initialPrompt: string | null;
  familyId: string; userId: string; memberId: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [mood, setMood] = useState<Mood | null>(entry?.mood ?? null);
  const [body, setBody] = useState(entry?.body ?? '');
  const speech = useSpeechRecognition();

  // Fold finalized speech into the body as it arrives.
  const lastTranscript = useMemo(() => speech.transcript, [speech.transcript]);
  function toggleMic() {
    if (speech.listening) {
      speech.stop();
      if (lastTranscript) { setBody((b) => appendTranscript(b, lastTranscript)); speech.reset(); }
    } else {
      speech.reset();
      speech.start();
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (speech.listening && speech.transcript) { setBody((b) => appendTranscript(b, speech.transcript)); speech.stop(); }
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim() || null;
    const finalBody = body.trim();
    if (!finalBody && !title) return toastError(t('journalModule.writeSomethingFirst'));
    setLoading(true);
    const supabase = createClient();
    const patch = { title, body: finalBody, mood, prompt: initialPrompt };
    const { error: saveErr } = entry
      ? await supabase.from('journal_entries').update(patch).eq('id', entry.id)
      : await supabase.from('journal_entries').insert({ family_id: familyId, member_id: memberId, created_by: userId, ...patch });
    setLoading(false);
    if (saveErr) return toastError(describeDbError(saveErr));
    success(entry ? 'Entry saved' : 'Entry added');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={entry ? 'Edit Entry' : 'New Entry'}>
      <form onSubmit={onSubmit} className="space-y-4">
        {initialPrompt && (
          <p className="flex items-start gap-1.5 rounded-xl bg-surface/60 p-3 text-sm italic text-muted">
            <Quote className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-brand-text" /> {initialPrompt}
          </p>
        )}

        <div>
          <label className="mb-1.5 block text-sm font-medium">{t('journal.howAreYouFeeling')}</label>
          <div className="flex gap-2">
            {MOODS.map((m) => (
              <button key={m.id} type="button" onClick={() => setMood(mood === m.id ? null : m.id)}
                className={cn('flex flex-1 flex-col items-center gap-1 rounded-xl border-2 py-2 text-xs transition',
                  mood === m.id ? 'border-brand bg-brand/10' : 'border-border text-muted hover:border-brand/40')}>
                <span className="text-xl">{m.emoji}</span>{m.label}
              </button>
            ))}
          </div>
        </div>

        <Field label={t('journal.titleOptional')}>
          {(id) => <Input id={id} name="title" defaultValue={entry?.title ?? ''} placeholder={t('journal.aLineToRememberThisBy')} />}
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium">{t('journal.yourEntry')}</label>
            {speech.supported && (
              <button type="button" onClick={toggleMic}
                className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition',
                  speech.listening ? 'bg-rose-500/10 text-rose-500' : 'text-brand-text hover:bg-brand/10')}>
                {speech.listening ? <><MicOff className="h-3 w-3" /> {t('journal.stop')}</> : <><Mic className="h-3 w-3" /> {t('journal.speak')}</>}
              </button>
            )}
          </div>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)}
            placeholder={t('journal.letItOutWriteFreelyNo')} className="min-h-[200px]" autoFocus />
          {speech.listening && <p className="mt-1 text-xs text-rose-500">Listening… {speech.transcript}</p>}
          {speech.error && <p className="mt-1 text-xs text-danger">{speech.error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('journal.cancel')}</Button>
          <Button type="submit" loading={loading}>{entry ? 'Save' : 'Add Entry'}</Button>
        </div>
      </form>
    </Modal>
  );
}
