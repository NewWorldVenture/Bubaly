'use client';
import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, ArrowRight, Upload, FileText, CalendarDays, CheckSquare, ShoppingCart,
  StickyNote, CheckCircle2, Loader2, X, FileUp, PartyPopper, Sparkles,
} from 'lucide-react';
import { COMPETITORS, competitorByKey, CSV_NAME_COLUMNS, type Competitor, type ImportTarget } from '@/lib/migrate/competitors';
import { parseICS, parseCSV, csvToItems, type ImportedEvent, type CsvTable } from '@/lib/migrate/parse';
import { commitImport, type ImportResult } from '@/app/(app)/dashboard/migrate/actions';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type ParsedFile = {
  id: string; name: string; kind: 'ics' | 'csv';
  events?: ImportedEvent[]; table?: CsvTable; target: ImportTarget;
};

const CSV_TARGETS: ImportTarget[] = ['tasks', 'grocery', 'notes'];
const uid = () => Math.random().toString(36).slice(2);

export function MigrateWizard() {
  const tr = useTranslations();
  const router = useRouter();
  const [step, setStep] = useState<'pick' | 'upload' | 'done'>('pick');
  const [source, setSource] = useState<Competitor | null>(null);
  const [files, setFiles] = useState<ParsedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    const next: ParsedFile[] = [];
    for (const file of Array.from(list)) {
      const text = await file.text();
      const isIcs = file.name.toLowerCase().endsWith('.ics') || text.includes('BEGIN:VCALENDAR');
      if (isIcs) {
        const events = parseICS(text);
        if (events.length === 0) { setError(`No events found in ${file.name}.`); continue; }
        next.push({ id: uid(), name: file.name, kind: 'ics', events, target: 'events' });
      } else {
        const table = parseCSV(text);
        if (table.headers.length === 0) { setError(`Couldn’t read ${file.name} as CSV.`); continue; }
        next.push({ id: uid(), name: file.name, kind: 'csv', table, target: 'tasks' });
      }
    }
    setFiles((f) => [...f, ...next]);
  }

  const preview = useMemo(() => {
    const events = files.flatMap((f) => f.events ?? []);
    const pick = (t: ImportTarget) => files.filter((f) => f.kind === 'csv' && f.target === t)
      .flatMap((f) => csvToItems(f.table!, CSV_NAME_COLUMNS[t], ['notes', 'note', 'quantity', 'qty', 'description', 'details']));
    return { events, tasks: pick('tasks'), grocery: pick('grocery'), notes: pick('notes') };
  }, [files]);

  const total = preview.events.length + preview.tasks.length + preview.grocery.length + preview.notes.length;

  function runImport() {
    if (!source || total === 0) return;
    start(async () => {
      setError(null);
      const res = await commitImport({
        source: source.key,
        events: preview.events,
        tasks: preview.tasks,
        grocery: preview.grocery,
        notes: preview.notes,
      });
      if (res.ok) { setResult(res); setStep('done'); router.refresh(); }
      else setError(res.error);
    });
  }

  // ── Step: pick source ──
  if (step === 'pick') {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COMPETITORS.map((c) => (
            <button key={c.key} type="button" onClick={() => { setSource(c); setStep('upload'); }}
              className="group flex flex-col rounded-2xl border border-border bg-surface/40 p-5 text-left transition hover:border-brand/40 hover:bg-elevated">
              <div className="flex items-center gap-3">
                <span className={cn('grid h-11 w-11 place-items-center rounded-xl text-lg font-black text-white', c.accent)}>{c.name[0]}</span>
                <div><p className="font-semibold">{c.name}</p><p className="text-xs text-muted">{c.formats.map((f) => f.toUpperCase()).join(' · ')}</p></div>
              </div>
              <p className="mt-3 text-sm text-muted">{c.blurb}</p>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {c.transfers.map((t) => <li key={t} className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-muted">{t}</li>)}
              </ul>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-text">Migrate from {c.name} <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
            </button>
          ))}
          <button type="button" onClick={() => { setSource(competitorByKey('cozi')!); setStep('upload'); }}
            className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border p-5 text-center text-muted transition hover:border-brand/40 hover:text-fg">
            <FileUp className="h-7 w-7" />
            <p className="mt-2 text-sm font-medium">{tr('migrateWizard.anotherApp')}</p>
            <p className="text-xs">{tr('migrateWizard.uploadAnyIcsOrCsvExport')}</p>
          </button>
        </div>
      </div>
    );
  }

  // ── Step: done ──
  if (step === 'done' && result && result.ok) {
    const { counts } = result;
    return (
      <div className="rounded-3xl border border-emerald-400/30 bg-emerald-500/5 p-8 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-500/15 text-emerald-400"><PartyPopper className="h-8 w-8" /></div>
        <h2 className="mt-4 text-xl font-bold">{tr('migrateWizard.youreAllMovedIn')}</h2>
        <p className="mt-1 text-sm text-muted">{tr('migrateWizard.importedFrom')} {source?.name} {tr('migrateWizard.intoYourFamily')}</p>
        <div className="mx-auto mt-5 grid max-w-md grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Events', value: counts.events, href: '/dashboard/calendar', icon: CalendarDays },
            { label: 'Tasks', value: counts.tasks, href: '/dashboard/chores', icon: CheckSquare },
            { label: 'Grocery', value: counts.grocery, href: '/dashboard/grocery', icon: ShoppingCart },
            { label: 'Notes', value: counts.notes, href: '/dashboard/notes', icon: StickyNote },
          ].map((s) => (
            <Link key={s.label} href={s.href} className="rounded-2xl border border-border bg-surface/40 p-3 transition hover:bg-elevated">
              <s.icon className="mx-auto h-5 w-5 text-brand-text" />
              <p className="mt-1 text-xl font-bold tabular-nums">{s.value}</p>
              <p className="text-[11px] text-muted">{s.label}</p>
            </Link>
          ))}
        </div>
        {result.skipped > 0 && <p className="mt-3 text-xs text-muted">{result.skipped} {tr('migrateWizard.duplicateEvent')}{result.skipped === 1 ? '' : 's'} skipped.</p>}
        <div className="mt-6 flex justify-center gap-2">
          <button type="button" onClick={() => { setStep('pick'); setSource(null); setFiles([]); setResult(null); }} className="rounded-xl border border-border bg-surface/40 px-4 py-2 text-sm font-medium hover:bg-elevated">{tr('migrateWizard.importMore')}</button>
          <Link href="/dashboard" className="btn-cta">{tr('migrateWizard.goToDashboard')}</Link>
        </div>
      </div>
    );
  }

  // ── Step: upload + preview ──
  return (
    <div className="space-y-4">
      <button type="button" onClick={() => { setStep('pick'); setFiles([]); setError(null); }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> {tr('migrateWizard.chooseADifferentApp')}</button>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        {/* Instructions */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-3">
            <span className={cn('grid h-10 w-10 place-items-center rounded-xl text-lg font-black text-white', source?.accent)}>{source?.name[0]}</span>
            <div><p className="font-semibold">{tr('migrateWizard.exportFrom')} {source?.name}</p><p className="text-xs text-muted">{tr('migrateWizard.followTheseStepsThenUploadThe')}</p></div>
          </div>
          <ol className="mt-4 space-y-2.5">
            {source?.steps.map((s, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand/15 text-[11px] font-bold text-brand-text">{i + 1}</span>
                <span className="text-fg/85">{s}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 flex items-center gap-1.5 rounded-xl bg-white/5 p-3 text-xs text-muted"><Sparkles className="h-4 w-4 shrink-0 text-brand-text" /> {tr('migrateWizard.acceptsIcsCalendarsAndCsvLists')}</p>
        </div>

        {/* Upload + preview */}
        <div className="space-y-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            onClick={() => inputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-surface/30 p-8 text-center transition hover:border-brand/40 hover:bg-elevated"
          >
            <Upload className="h-8 w-8 text-muted" />
            <p className="mt-2 text-sm font-medium">{tr('migrateWizard.dropFilesHereOrClickTo')}</p>
            <p className="text-xs text-muted">{tr('migrateWizard.icsOrCsv')}</p>
            <input ref={inputRef} type="file" accept=".ics,.csv,text/calendar,text/csv" multiple className="hidden"
              onChange={(e) => addFiles(e.target.files)} />
          </div>

          {error && <p className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}

          {files.length > 0 && (
            <ul className="space-y-2">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.name}</p>
                    <p className="text-xs text-muted">{f.kind === 'ics' ? `${f.events!.length} events` : `${f.table!.rows.length} rows`}</p>
                  </div>
                  {f.kind === 'csv' && (
                    <select value={f.target} onChange={(e) => setFiles((arr) => arr.map((x) => x.id === f.id ? { ...x, target: e.target.value as ImportTarget } : x))}
                      className="rounded-lg border border-border bg-bg px-2 py-1 text-xs outline-none focus:border-brand">
                      {CSV_TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                  <button type="button" aria-label="Remove" onClick={() => setFiles((arr) => arr.filter((x) => x.id !== f.id))} className="text-muted hover:text-danger"><X className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}

          {total > 0 && (
            <div className="rounded-2xl border border-border bg-surface/40 p-4">
              <p className="mb-2 text-sm font-semibold">{tr('migrateWizard.readyToImport')}</p>
              <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                {[
                  { label: 'Events', value: preview.events.length, icon: CalendarDays },
                  { label: 'Tasks', value: preview.tasks.length, icon: CheckSquare },
                  { label: 'Grocery', value: preview.grocery.length, icon: ShoppingCart },
                  { label: 'Notes', value: preview.notes.length, icon: StickyNote },
                ].map((s) => (
                  <li key={s.label} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2"><s.icon className="h-4 w-4 text-brand-text" /><span className="font-bold tabular-nums">{s.value}</span><span className="text-xs text-muted">{s.label}</span></li>
                ))}
              </ul>
              {preview.events.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-muted">{tr('migrateWizard.sampleEvents')}</p>
                  <ul className="mt-1 space-y-1">
                    {preview.events.slice(0, 3).map((e, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /><span className="truncate">{e.title}</span><span className="ml-auto shrink-0 text-muted">{new Date(e.startsAt).toLocaleDateString()}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              <button type="button" disabled={pending} onClick={runImport} className="btn-cta mt-4 w-full justify-center">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {tr('migrateWizard.import')} {total} item{total === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
