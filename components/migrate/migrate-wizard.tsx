'use client';
import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, ArrowRight, Upload, FileText, CalendarDays, CheckSquare, ShoppingCart,
  StickyNote, CheckCircle2, Loader2, X, FileUp, PartyPopper, Sparkles, Users, Copy,
} from 'lucide-react';
import { COMPETITORS, competitorByKey, CSV_NAME_COLUMNS, TARGET_LABELS, type Competitor, type ImportTarget } from '@/lib/migrate/competitors';
import {
  parseICS, parseCSV, parseVCard, csvToItems, csvToContacts, dedupeContacts,
  type ImportedContact, type ImportedEvent, type CsvTable,
} from '@/lib/migrate/parse';
import type { ExistingMember, ResolutionPlan } from '@/lib/migrate/resolve';
import { commitImport, prepareImport, type ImportResult } from '@/app/(app)/dashboard/migrate/actions';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type ParsedFile = {
  id: string; name: string; kind: 'ics' | 'csv' | 'vcf';
  events?: ImportedEvent[]; table?: CsvTable; contacts?: ImportedContact[]; target: ImportTarget;
};

const CSV_TARGETS: ImportTarget[] = ['tasks', 'grocery', 'notes', 'contacts'];
/** How many rows the review step renders per kind. Beyond this the proposals
 *  still apply — they just are not individually editable, which the UI says. */
const REVIEW_LIMIT = 200;
const uid = () => Math.random().toString(36).slice(2);

/** One row's "who does this belong to" picker. */
function MemberSelect({ members, value, label, nobodyLabel, onChange }: {
  members: ExistingMember[]; value: string; label: string; nobodyLabel: string; onChange: (next: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[9rem] shrink-0 rounded-lg border border-border bg-bg px-2 py-1 text-xs outline-none focus:border-brand"
    >
      <option value="">{nobodyLabel}</option>
      {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
    </select>
  );
}

export function MigrateWizard() {
  const tr = useTranslations();
  const router = useRouter();
  const [step, setStep] = useState<'pick' | 'upload' | 'review' | 'done'>('pick');
  const [source, setSource] = useState<Competitor | null>(null);
  const [files, setFiles] = useState<ParsedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [plan, setPlan] = useState<ResolutionPlan | null>(null);
  const [members, setMembers] = useState<ExistingMember[]>([]);
  // Reviewer overrides, keyed `${kind}:${index}` so an untouched item keeps the
  // proposal rather than being pinned to whatever it was when the plan loaded.
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [skips, setSkips] = useState<Record<string, boolean>>({});
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    const next: ParsedFile[] = [];
    for (const file of Array.from(list)) {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      const isIcs = lower.endsWith('.ics') || text.includes('BEGIN:VCALENDAR');
      const isVcf = lower.endsWith('.vcf') || text.includes('BEGIN:VCARD');
      if (isIcs) {
        const events = parseICS(text);
        if (events.length === 0) { setError(tr('migrateWizard.noEventsFoundIn', { file: file.name })); continue; }
        next.push({ id: uid(), name: file.name, kind: 'ics', events, target: 'events' });
      } else if (isVcf) {
        const contacts = dedupeContacts(parseVCard(text));
        if (contacts.length === 0) { setError(tr('migrateWizard.noContactsFoundIn', { file: file.name })); continue; }
        next.push({ id: uid(), name: file.name, kind: 'vcf', contacts, target: 'contacts' });
      } else {
        const table = parseCSV(text);
        if (table.headers.length === 0) { setError(tr('migrateWizard.couldNotReadAsCsv', { file: file.name })); continue; }
        next.push({ id: uid(), name: file.name, kind: 'csv', table, target: 'tasks' });
      }
    }
    setFiles((f) => [...f, ...next]);
  }

  const preview = useMemo(() => {
    const events = files.flatMap((f) => f.events ?? []);
    const pick = (t: ImportTarget) => files.filter((f) => f.kind === 'csv' && f.target === t)
      .flatMap((f) => csvToItems(f.table!, CSV_NAME_COLUMNS[t], ['notes', 'note', 'quantity', 'qty', 'description', 'details']));
    const contacts = dedupeContacts([
      ...files.filter((f) => f.kind === 'vcf').flatMap((f) => f.contacts ?? []),
      ...files.filter((f) => f.kind === 'csv' && f.target === 'contacts').flatMap((f) => csvToContacts(f.table!)),
    ]);
    return { events, tasks: pick('tasks'), grocery: pick('grocery'), notes: pick('notes'), contacts };
  }, [files]);

  const total = preview.events.length + preview.tasks.length + preview.grocery.length
    + preview.notes.length + preview.contacts.length;

  const memberFor = (kind: 'event' | 'task' | 'contact', index: number, proposed: string | null) => {
    const override = assignments[`${kind}:${index}`];
    if (override === undefined) return proposed;
    return override === '' ? null : override;
  };
  const skipped = (kind: 'event' | 'contact', index: number, duplicate: boolean) => {
    const override = skips[`${kind}:${index}`];
    return override === undefined ? duplicate : override;
  };

  function loadReview() {
    if (!source || total === 0) return;
    start(async () => {
      setError(null);
      const res = await prepareImport({
        source: source.key,
        events: preview.events,
        tasks: preview.tasks,
        contacts: preview.contacts,
      });
      if (!res.ok) { setError(res.error); return; }
      setPlan(res.plan);
      setMembers(res.members);
      setAssignments({});
      setSkips({});
      setStep('review');
    });
  }

  function runImport() {
    if (!source || total === 0 || !plan) return;
    start(async () => {
      setError(null);
      const res = await commitImport({
        source: source.key,
        events: preview.events.map((e, i) => ({
          ...e,
          category: plan.events[i]?.category ?? null,
          memberId: memberFor('event', i, plan.events[i]?.memberId ?? null),
          skip: skipped('event', i, plan.events[i]?.duplicate ?? false),
        })),
        tasks: preview.tasks.map((t, i) => ({ ...t, memberId: memberFor('task', i, plan.tasks[i]?.memberId ?? null) })),
        grocery: preview.grocery,
        notes: preview.notes,
        contacts: preview.contacts.map((c, i) => ({
          ...c,
          memberId: memberFor('contact', i, plan.contacts[i]?.memberId ?? null),
          skip: skipped('contact', i, plan.contacts[i]?.duplicate ?? false),
        })),
      });
      if (res.ok) { setResult(res); setStep('done'); router.refresh(); }
      else setError(res.error);
    });
  }

  function resetAll() {
    setStep('pick'); setSource(null); setFiles([]); setResult(null); setPlan(null); setMembers([]);
    setAssignments({}); setSkips({}); setError(null);
  }

  /** Bound once per row; the component itself lives at module scope so the
   *  select is not remounted (and does not lose focus) on every state change. */
  const memberSelect = (kind: 'event' | 'task' | 'contact', index: number, proposed: string | null) => (
    <MemberSelect
      members={members}
      value={memberFor(kind, index, proposed) ?? ''}
      label={tr('migrateWizard.reviewBelongsTo')}
      nobodyLabel={tr('migrateWizard.reviewNobody')}
      onChange={(next) => setAssignments((a) => ({ ...a, [`${kind}:${index}`]: next }))}
    />
  );

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
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-text">{tr('migrateWizard.migrateFrom', { app: c.name })} <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
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
        <div className="mx-auto mt-5 grid max-w-md grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { key: 'events' as const, value: counts.events, href: '/dashboard/calendar', icon: CalendarDays },
            { key: 'tasks' as const, value: counts.tasks, href: '/dashboard/chores', icon: CheckSquare },
            { key: 'grocery' as const, value: counts.grocery, href: '/dashboard/grocery', icon: ShoppingCart },
            { key: 'notes' as const, value: counts.notes, href: '/dashboard/notes', icon: StickyNote },
            { key: 'contacts' as const, value: counts.contacts, href: '/dashboard/contacts', icon: Users },
          ].map((s) => (
            <Link key={s.key} href={s.href} className="rounded-2xl border border-border bg-surface/40 p-3 transition hover:bg-elevated">
              <s.icon className="mx-auto h-5 w-5 text-brand-text" />
              <p className="mt-1 text-xl font-bold tabular-nums">{s.value}</p>
              <p className="text-[11px] text-muted">{tr(TARGET_LABELS[s.key].labelKey)}</p>
            </Link>
          ))}
        </div>
        {result.assigned > 0 && <p className="mt-3 text-xs text-muted">{tr('migrateWizard.assignedToAPerson', { count: result.assigned })}</p>}
        {result.skipped > 0 && <p className="mt-1 text-xs text-muted">{tr('migrateWizard.skippedDuplicates', { count: result.skipped })}</p>}
        <div className="mt-6 flex justify-center gap-2">
          <button type="button" onClick={resetAll} className="rounded-xl border border-border bg-surface/40 px-4 py-2 text-sm font-medium hover:bg-elevated">{tr('migrateWizard.importMore')}</button>
          <Link href="/dashboard" className="btn-cta">{tr('migrateWizard.goToDashboard')}</Link>
        </div>
      </div>
    );
  }

  // ── Step: review (entity resolution before anything is written) ──
  if (step === 'review' && plan) {
    const included = preview.events.filter((_, i) => !skipped('event', i, plan.events[i]?.duplicate ?? false)).length
      + preview.tasks.length + preview.grocery.length + preview.notes.length
      + preview.contacts.filter((_, i) => !skipped('contact', i, plan.contacts[i]?.duplicate ?? false)).length;
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => { setStep('upload'); setError(null); }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4" /> {tr('migrateWizard.reviewBackToFiles')}
        </button>

        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="text-base font-bold">{tr('migrateWizard.reviewHeading')}</h2>
          <p className="mt-1 text-sm text-muted">{tr('migrateWizard.reviewIntro')}</p>
          {(plan.duplicateEvents + plan.duplicateContacts) > 0 && (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
              <Copy className="h-3.5 w-3.5 shrink-0" /> {tr('migrateWizard.reviewDuplicatesFound', { count: plan.duplicateEvents + plan.duplicateContacts })}
            </p>
          )}
        </div>

        {error && <p className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}

        {preview.events.length > 0 && (
          <section className="rounded-2xl border border-border bg-surface/40 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-brand-text" /> {tr(TARGET_LABELS.events.labelKey)} · {preview.events.length}</h3>
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {preview.events.slice(0, REVIEW_LIMIT).map((e, i) => {
                const row = plan.events[i];
                const isSkipped = skipped('event', i, row?.duplicate ?? false);
                return (
                  <li key={`${e.title}-${e.startsAt}-${i}`} className={cn('flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2 text-xs', isSkipped && 'opacity-50')}>
                    <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                    <span className="hidden shrink-0 text-muted sm:inline">{new Date(e.startsAt).toLocaleDateString()}</span>
                    {row?.duplicate && <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">{tr('migrateWizard.reviewAlreadyHere')}</span>}
                    {memberSelect('event', i, row?.memberId ?? null)}
                    <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                      <input type="checkbox" checked={isSkipped} onChange={(ev) => setSkips((s) => ({ ...s, [`event:${i}`]: ev.target.checked }))} />
                      {tr('migrateWizard.reviewSkip')}
                    </label>
                  </li>
                );
              })}
            </ul>
            {preview.events.length > REVIEW_LIMIT && (
              <p className="mt-2 text-[11px] text-muted">{tr('migrateWizard.reviewShowingFirst', { count: REVIEW_LIMIT })}</p>
            )}
          </section>
        )}

        {preview.contacts.length > 0 && (
          <section className="rounded-2xl border border-border bg-surface/40 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-brand-text" /> {tr(TARGET_LABELS.contacts.labelKey)} · {preview.contacts.length}</h3>
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {preview.contacts.slice(0, REVIEW_LIMIT).map((c, i) => {
                const row = plan.contacts[i];
                const isSkipped = skipped('contact', i, row?.duplicate ?? false);
                return (
                  <li key={`${c.name}-${i}`} className={cn('flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2 text-xs', isSkipped && 'opacity-50')}>
                    <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                    <span className="hidden min-w-0 shrink truncate text-muted sm:inline">{c.emails[0] ?? c.phones[0] ?? ''}</span>
                    {row?.duplicate && <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">{tr('migrateWizard.reviewAlreadyHere')}</span>}
                    {memberSelect('contact', i, row?.memberId ?? null)}
                    <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                      <input type="checkbox" checked={isSkipped} onChange={(ev) => setSkips((s) => ({ ...s, [`contact:${i}`]: ev.target.checked }))} />
                      {tr('migrateWizard.reviewSkip')}
                    </label>
                  </li>
                );
              })}
            </ul>
            {preview.contacts.length > REVIEW_LIMIT && (
              <p className="mt-2 text-[11px] text-muted">{tr('migrateWizard.reviewShowingFirst', { count: REVIEW_LIMIT })}</p>
            )}
          </section>
        )}

        {preview.tasks.length > 0 && (
          <section className="rounded-2xl border border-border bg-surface/40 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><CheckSquare className="h-4 w-4 text-brand-text" /> {tr(TARGET_LABELS.tasks.labelKey)} · {preview.tasks.length}</h3>
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {preview.tasks.slice(0, REVIEW_LIMIT).map((t, i) => (
                <li key={`${t.name}-${i}`} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                  {memberSelect('task', i, plan.tasks[i]?.memberId ?? null)}
                </li>
              ))}
            </ul>
            {preview.tasks.length > REVIEW_LIMIT && (
              <p className="mt-2 text-[11px] text-muted">{tr('migrateWizard.reviewShowingFirst', { count: REVIEW_LIMIT })}</p>
            )}
          </section>
        )}

        {(preview.grocery.length > 0 || preview.notes.length > 0) && (
          <p className="text-xs text-muted">{tr('migrateWizard.reviewGroceryAndNotes', { grocery: preview.grocery.length, notes: preview.notes.length })}</p>
        )}

        <button type="button" disabled={pending || included === 0} onClick={runImport} className="btn-cta w-full justify-center">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {tr('migrateWizard.importCount', { count: included })}
        </button>
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
          <p className="mt-4 flex items-center gap-1.5 rounded-xl bg-white/5 p-3 text-xs text-muted"><Sparkles className="h-4 w-4 shrink-0 text-brand-text" /> {tr('migrateWizard.acceptsIcsCsvAndVcf')}</p>
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
            <p className="text-xs text-muted">{tr('migrateWizard.icsCsvOrVcf')}</p>
            <input ref={inputRef} type="file" accept=".ics,.csv,.vcf,text/calendar,text/csv,text/vcard" multiple className="hidden"
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
                    <p className="text-xs text-muted">
                      {f.kind === 'ics' ? tr('migrateWizard.nEvents', { count: f.events!.length })
                        : f.kind === 'vcf' ? tr('migrateWizard.nContacts', { count: f.contacts!.length })
                        : tr('migrateWizard.nRows', { count: f.table!.rows.length })}
                    </p>
                  </div>
                  {f.kind === 'csv' && (
                    <select value={f.target} onChange={(e) => setFiles((arr) => arr.map((x) => x.id === f.id ? { ...x, target: e.target.value as ImportTarget } : x))}
                      aria-label={tr('migrateWizard.whatIsInThisFile')}
                      className="rounded-lg border border-border bg-bg px-2 py-1 text-xs outline-none focus:border-brand">
                      {CSV_TARGETS.map((t) => <option key={t} value={t}>{tr(TARGET_LABELS[t].labelKey)}</option>)}
                    </select>
                  )}
                  <button type="button" aria-label={tr('migrateWizard.remove')} onClick={() => setFiles((arr) => arr.filter((x) => x.id !== f.id))} className="text-muted hover:text-danger"><X className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}

          {total > 0 && (
            <div className="rounded-2xl border border-border bg-surface/40 p-4">
              <p className="mb-2 text-sm font-semibold">{tr('migrateWizard.readyToImport')}</p>
              <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                {[
                  { key: 'events' as const, value: preview.events.length, icon: CalendarDays },
                  { key: 'tasks' as const, value: preview.tasks.length, icon: CheckSquare },
                  { key: 'grocery' as const, value: preview.grocery.length, icon: ShoppingCart },
                  { key: 'notes' as const, value: preview.notes.length, icon: StickyNote },
                  { key: 'contacts' as const, value: preview.contacts.length, icon: Users },
                ].map((s) => (
                  <li key={s.key} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2"><s.icon className="h-4 w-4 text-brand-text" /><span className="font-bold tabular-nums">{s.value}</span><span className="text-xs text-muted">{tr(TARGET_LABELS[s.key].labelKey)}</span></li>
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
              <button type="button" disabled={pending} onClick={loadReview} className="btn-cta mt-4 w-full justify-center">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} {tr('migrateWizard.reviewCount', { count: total })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
