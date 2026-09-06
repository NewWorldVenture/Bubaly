'use client';

import { useMemo, useState } from 'react';
import { Hammer, Plus, Check, Pencil, Trash2, Wallet, CalendarClock, FileText, Package, Wand2, ShoppingCart, ExternalLink, ArrowRight, XCircle, Users } from 'lucide-react';
import Link from 'next/link';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables, HomeProjectKind, HomeProjectPriority, HomeProjectStatus, ProjectQuoteStatus } from '@/lib/database.types';
import {
  PROJECT_KINDS, PROJECT_STATUSES, PRIORITIES, QUOTE_STATUSES, BOARD, kindMeta, statusLabel, columnFor, suggestScope, materialsTotals, materialLineCents,
  compareQuotes, budgetHealth, schedule, nextAction, projectsSummary, money, isoDate, type ScopeTemplate,
} from '@/lib/projects/planner';
import { useTranslations } from '@/components/i18n/locale-provider';

type Project = Tables<'home_projects'>;
type Material = Tables<'project_materials'>;
type Quote = Tables<'project_quotes'>;
type Contractor = Pick<Tables<'home_contractors'>, 'id' | 'name' | 'company' | 'trade' | 'phone' | 'is_preferred'>;

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const dollarsToCents = (v: FormDataEntryValue | null) => { const raw = String(v ?? '').trim(); if (!raw) return null; const n = Number(raw.replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const centsToDollars = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(c / 100));
const PRIORITY_STYLE: Record<HomeProjectPriority, string> = { high: 'border-rose-500/30 bg-rose-500/10 text-rose-200', medium: 'border-amber-500/30 bg-amber-500/10 text-amber-200', low: 'border-border bg-surface/60 text-muted' };

export function ProjectsModule() {
  const tr = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const projects = useRealtimeQuery<Project>({
    table: 'home_projects', familyId,
    fetcher: (s) => s.from('home_projects').select('*').eq('family_id', familyId).order('updated_at', { ascending: false }).limit(300),
    deps: [familyId],
  });
  const materials = useRealtimeQuery<Material>({
    table: 'project_materials', familyId,
    fetcher: (s) => s.from('project_materials').select('*').eq('family_id', familyId).order('created_at').limit(1000),
    deps: [familyId],
  });
  const quotes = useRealtimeQuery<Quote>({
    table: 'project_quotes', familyId,
    fetcher: (s) => s.from('project_quotes').select('*').eq('family_id', familyId).order('amount_cents').limit(600),
    deps: [familyId],
  });
  const contractors = useRealtimeQuery<Contractor>({
    table: 'home_contractors', familyId,
    fetcher: (s) => s.from('home_contractors').select('id,name,company,trade,phone,is_preferred').eq('family_id', familyId).is('deleted_at', null).order('is_preferred', { ascending: false }).order('name').limit(100),
    deps: [familyId],
  });

  const [projectForm, setProjectForm] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const today = useMemo(() => new Date(), []);
  const summary = useMemo(() => projectsSummary(projects.data, materials.data, quotes.data, today), [projects.data, materials.data, quotes.data, today]);
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;
  const openProject = projects.data.find((p) => p.id === openId) ?? null;

  async function setStatus(p: Project, status: HomeProjectStatus) {
    const { error } = await createClient().from('home_projects').update({ status, completed_at: status === 'done' ? new Date().toISOString() : null }).eq('id', p.id);
    if (error) return toastError(describeDbError(error));
    success(`${p.title}: ${statusLabel(status).toLowerCase()}`);
  }

  async function deleteProject(p: Project) {
    if (!confirm(`Delete “${p.title}” with its materials and quotes?`)) return;
    const { error } = await createClient().from('home_projects').delete().eq('id', p.id);
    if (error) return toastError(describeDbError(error));
    setOpenId(null);
    success('Project deleted');
  }

  const loading = projects.loading || materials.loading || quotes.loading;
  const error = projects.error || materials.error || quotes.error;
  const refresh = () => { void projects.refresh(); void materials.refresh(); void quotes.refresh(); void contractors.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load your projects. Refresh and try again." onRetry={refresh} />;

  const Card = ({ p }: { p: Project }) => {
  const tr = useTranslations();
    const bh = budgetHealth(p, materials.data, quotes.data, today);
    const sc = schedule(p, today);
    const mt = materialsTotals(materials.data, p.id);
    const qc = compareQuotes(quotes.data, p.id, today);
    return (
      <li>
        <button onClick={() => setOpenId(p.id)} className={cn('w-full rounded-2xl border p-4 text-left transition hover:border-brand/40', sc.state === 'overdue' ? 'border-rose-500/30 bg-rose-500/5' : bh.status === 'over' ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-surface/40')}>
          <div className="flex items-start gap-2">
            <span className="text-xl" aria-hidden>{kindMeta(p.kind).emoji}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{p.title}</p>
              <p className="text-xs text-muted">{p.room ? `${p.room} · ` : ''}{p.is_diy ? 'DIY' : 'Hiring'}{p.owner_id ? ` · ${nameOf(p.owner_id)}` : ''}</p>
            </div>
            <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', PRIORITY_STYLE[p.priority])}>{p.priority}</span>
          </div>
          {bh.status !== 'no_budget' && (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-border"><div className={cn('h-full rounded-full', bh.status === 'over' ? 'bg-rose-400' : bh.status === 'near' ? 'bg-amber-400' : 'bg-brand')} style={{ width: `${Math.min(100, bh.pct ?? 0)}%` }} /></div>
              <p className="mt-1 text-[11px] text-muted">{money(bh.forecastCents)} of {money(p.budget_cents)}{bh.status === 'over' ? ` · ${money(-(bh.remainingCents ?? 0))} over` : ''}</p>
            </div>
          )}
          <p className="mt-2 flex items-center gap-1 text-xs text-brand-text"><ArrowRight className="h-3 w-3" /> {nextAction(p, materials.data, quotes.data, today)}</p>
          <p className="mt-1 text-[11px] text-muted">
            {mt.count ? `${mt.purchased}/${mt.count} materials` : 'no materials'}{qc.received || qc.awaiting ? ` · ${qc.received} quote${qc.received === 1 ? '' : 's'}${qc.awaiting ? ` (+${qc.awaiting} waiting)` : ''}` : ''}
            {sc.state === 'overdue' ? <span className="text-rose-300"> · {-(sc.days ?? 0)}{tr('projects.dOverdue')}</span> : sc.state === 'due_soon' ? <span className="text-amber-300"> {tr('projects.dueIn')} {sc.days}d</span> : p.target_start ? ` · ${fmtDate(p.target_start)}` : ''}
          </p>
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={tr('projects.homeProjects')}
        description="Every project as scope → materials → budget → quotes → done. The board says what to do next on each one; budget health counts what is already committed, not just what you hoped."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <AiInsight kind="projects" iconOnly />
            <Link href="/dashboard/home" className="inline-flex items-center gap-1 rounded-xl border border-border px-3 py-2 text-sm text-muted hover:text-fg coarse:min-h-11"><Users className="h-4 w-4" /> {tr('projects.contractors')}</Link>
            <Button onClick={() => setProjectForm({ open: true, project: null })}><Plus className="h-4 w-4" /> {tr('projects.newProject')}</Button>
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <div className={cn('rounded-2xl border p-5', summary.overdue ? 'border-rose-500/30 bg-rose-500/10' : summary.over ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/40')}>
          <div className="flex items-center gap-2 text-sm font-semibold"><Hammer className="h-4 w-4 text-brand-text" /> {tr('projects.rightNow')}</div>
          <p className="mt-2 text-lg font-bold">{summary.text}</p>
          <p className="mt-1 text-xs text-muted">{summary.active} {tr('projects.active')} {summary.ideas} idea{summary.ideas === 1 ? '' : 's'}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4 text-brand-text" /> {tr('projects.plannedSpend')}</div>
          <p className="mt-2 text-2xl font-bold">{money(summary.forecastCents)}</p>
          <p className="mt-1 text-xs text-muted">{tr('projects.forecastAcrossActiveProjects')} {money(summary.budgetCents)} budgeted{summary.over ? ` · ${summary.over} over` : ''}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-brand-text" /> {tr('projects.deadlines')}</div>
          <p className="mt-2 text-2xl font-bold">{summary.dueSoon}<span className="text-sm font-normal text-muted"> {tr('projects.dueThisWeek')}</span></p>
          <p className="mt-1 text-xs text-muted">{summary.overdue} overdue</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4 text-brand-text" /> {tr('projects.quotes')}</div>
          <p className="mt-2 text-2xl font-bold">{summary.quotesWaiting}<span className="text-sm font-normal text-muted"> waiting</span></p>
          <p className="mt-1 text-xs text-muted">{contractors.data.length} contractor{contractors.data.length === 1 ? '' : 's'} {tr('projects.inYourBook')}</p>
        </div>
      </div>

      {projects.data.length === 0 ? (
        <EmptyState icon={Hammer} title={tr('projects.noProjectsYet')} description="Start with the thing you keep meaning to do. Type it and the planner suggests a materials list and whether to DIY or hire." action={<Button onClick={() => setProjectForm({ open: true, project: null })}><Plus className="h-4 w-4" /> {tr('projects.firstProject')}</Button>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-4">
          {BOARD.map((col) => {
            let list = projects.data.filter((p) => columnFor(p.status) === col.key);
            if (col.key === 'done' && !showDone) list = list.slice(0, 3);
            list = list.sort((a, b) => ['high', 'medium', 'low'].indexOf(a.priority) - ['high', 'medium', 'low'].indexOf(b.priority) || (a.target_end ?? a.target_start ?? '9999').localeCompare(b.target_end ?? b.target_start ?? '9999'));
            const total = projects.data.filter((p) => columnFor(p.status) === col.key).length;
            return (
              <section key={col.key} className="min-w-0">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{col.label}</h2>
                  <span className="text-xs text-muted">{total}</span>
                </div>
                <ul className="space-y-2">{list.map((p) => <Card key={p.id} p={p} />)}</ul>
                {col.key === 'done' && total > 3 && <button onClick={() => setShowDone((v) => !v)} className="mt-2 text-xs text-muted hover:text-fg">{showDone ? 'Show fewer' : `Show all ${total}`}</button>}
                {list.length === 0 && <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted">{tr('projects.nothingHere')}</p>}
              </section>
            );
          })}
        </div>
      )}

      {projectForm.open && (
        <ProjectForm familyId={familyId} userId={userId} members={members} contractors={contractors.data} project={projectForm.project} defaultOwner={selfMember?.id ?? null}
          onClose={() => setProjectForm({ open: false, project: null })} onSaved={(id) => { setProjectForm({ open: false, project: null }); setOpenId(id); success('Project saved'); }} />
      )}
      {openProject && (
        <ProjectDetail project={openProject} familyId={familyId} userId={userId} members={members} contractors={contractors.data} materials={materials.data.filter((m) => m.project_id === openProject.id)} quotes={quotes.data.filter((q) => q.project_id === openProject.id)} today={today}
          onClose={() => setOpenId(null)} onEdit={() => setProjectForm({ open: true, project: openProject })} onStatus={(s) => setStatus(openProject, s)} onDelete={() => deleteProject(openProject)} />
      )}
    </div>
  );
}

function ProjectForm({ familyId, userId, members, contractors, project, defaultOwner, onClose, onSaved }: { familyId: string; userId: string; members: { id: string; display_name: string }[]; contractors: Contractor[]; project: Project | null; defaultOwner: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState(project?.title ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [diy, setDiy] = useState(project?.is_diy ?? true);
  const [kind, setKind] = useState<HomeProjectKind>(project?.kind ?? 'repair');
  const [applied, setApplied] = useState<ScopeTemplate | null>(null);
  const suggestions = useMemo(() => (project ? [] : suggestScope(`${title} ${description}`).slice(0, 3)), [title, description, project]);

  function applyTemplate(t: ScopeTemplate) { setKind(t.kind); setDiy(t.diy); setApplied(t); }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = title.trim();
    if (!name) return toastError('Name the project');
    setLoading(true);
    const payload = {
      title: name, description: description.trim() || null, room: String(f.get('room') ?? '').trim() || null, kind, is_diy: diy,
      priority: String(f.get('priority') ?? 'medium') as HomeProjectPriority, status: String(f.get('status') ?? (project ? 'planning' : 'idea')) as HomeProjectStatus,
      budget_cents: dollarsToCents(f.get('budget')), labor_cents: dollarsToCents(f.get('labor')) ?? 0,
      target_start: String(f.get('target_start') ?? '') || null, target_end: String(f.get('target_end') ?? '') || null,
      owner_id: String(f.get('owner_id') ?? '') || null, contractor_id: String(f.get('contractor_id') ?? '') || null, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { data, error } = project
      ? await supabase.from('home_projects').update(payload).eq('id', project.id).select('id').single()
      : await supabase.from('home_projects').insert({ family_id: familyId, created_by: userId, ...payload }).select('id').single();
    if (error) { setLoading(false); return toastError(describeDbError(error)); }
    if (!project && applied) {
      // Starter materials from the matched template — a failed insert is
      // reported, the project itself is already saved.
      const { error: matError } = await supabase.from('project_materials').insert(applied.materials.map((m) => ({ family_id: familyId, project_id: data.id, name: m.name, quantity: m.quantity, unit: m.unit ?? null, est_cost_cents: m.estCents, created_by: userId })));
      if (matError) toastError(describeDbError(matError));
    }
    setLoading(false);
    onSaved(data.id);
  }

  return (
    <Modal open title={project ? 'Edit project' : 'New project'} description="Describe it in a sentence. Matching starter scopes appear below." onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('projects.project')} required>{(id) => <Input id={id} name="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr('projects.paintTheKidsRoom')} autoFocus />}</Field>
        <Field label={tr('projects.scopeDescription')}>{(id) => <Textarea id={id} name="description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr('projects.twoWallsLightBlueCeilingWhite')} />}</Field>
        {suggestions.length > 0 && (
          <div className="rounded-xl border border-brand/20 bg-brand/5 p-3">
            <p className="text-xs font-semibold text-brand-text"><Wand2 className="mr-1 inline h-3.5 w-3.5" />{tr('projects.starterScopes')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestions.map((t) => (
                <button type="button" key={t.key} onClick={() => applyTemplate(t)} aria-pressed={applied?.key === t.key} className={cn('rounded-full border px-3 py-1 text-xs coarse:min-h-9', applied?.key === t.key ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted hover:text-fg')}>
                  {kindMeta(t.kind).emoji} {t.key.replace('-', ' ')} · {t.materials.length} {tr('projects.materials')} {t.diy ? 'DIY' : 'hire'}
                </button>
              ))}
            </div>
            {applied?.laborHint && <p className="mt-2 text-xs text-muted">{applied.laborHint}</p>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('projects.kind')}>{(id) => <Select id={id} name="kind" value={kind} onChange={(e) => setKind(e.target.value as HomeProjectKind)}>{PROJECT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
          <Field label={tr('projects.room')}>{(id) => <Input id={id} name="room" defaultValue={project?.room ?? ''} placeholder={tr('projects.kidsRoom')} />}</Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={diy} onClick={() => setDiy(true)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', diy ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{tr('projects.wellDoIt')}</button>
          <button type="button" aria-pressed={!diy} onClick={() => setDiy(false)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', !diy ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{tr('projects.hireAPro')}</button>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('projects.priority')}>{(id) => <Select id={id} name="priority" defaultValue={project?.priority ?? 'medium'}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>}</Field>
          <Field label={tr('projects.status')}>{(id) => <Select id={id} name="status" defaultValue={project?.status ?? 'idea'}>{PROJECT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
          <Field label={tr('projects.owner')}>{(id) => <Select id={id} name="owner_id" defaultValue={project?.owner_id ?? defaultOwner ?? ''}><option value="">{tr('projects.anyone')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('projects.budget')}>{(id) => <Input id={id} name="budget" type="number" min={0} step={10} defaultValue={centsToDollars(project?.budget_cents)} placeholder="500" />}</Field>
          <Field label={tr('projects.labourPaidSoFar')}>{(id) => <Input id={id} name="labor" type="number" min={0} step={10} defaultValue={centsToDollars(project?.labor_cents ?? 0)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('projects.start')}>{(id) => <Input id={id} name="target_start" type="date" defaultValue={project?.target_start ?? ''} />}</Field>
          <Field label={tr('projects.finishBy')}>{(id) => <Input id={id} name="target_end" type="date" defaultValue={project?.target_end ?? ''} />}</Field>
        </div>
        {!diy && <Field label={tr('projects.contractorFromHomeMaintenance')}>{(id) => <Select id={id} name="contractor_id" defaultValue={project?.contractor_id ?? ''}><option value="">{tr('projects.notChosenYet')}</option>{contractors.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}{c.trade ? ` (${c.trade})` : ''}</option>)}</Select>}</Field>}
        <Field label={tr('projects.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={project?.notes ?? ''} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('projects.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('projects.saveProject')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectDetail({ project, familyId, userId, members, contractors, materials, quotes, today, onClose, onEdit, onStatus, onDelete }: {
  project: Project; familyId: string; userId: string; members: { id: string; display_name: string }[]; contractors: Contractor[]; materials: Material[]; quotes: Quote[]; today: Date;
  onClose: () => void; onEdit: () => void; onStatus: (s: HomeProjectStatus) => void; onDelete: () => void;
}) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<'materials' | 'quotes'>(project.is_diy ? 'materials' : 'quotes');
  const [materialForm, setMaterialForm] = useState<{ open: boolean; material: Material | null }>({ open: false, material: null });
  const [quoteForm, setQuoteForm] = useState<{ open: boolean; quote: Quote | null }>({ open: false, quote: null });
  const [suggesting, setSuggesting] = useState(false);
  const bh = budgetHealth(project, materials, quotes, today);
  const mt = materialsTotals(materials, project.id);
  const qc = compareQuotes(quotes, project.id, today);
  const sc = schedule(project, today);
  const templates = suggestScope(`${project.title} ${project.description ?? ''}`).slice(0, 1);
  const contractorOf = (id: string | null) => contractors.find((c) => c.id === id) ?? null;

  async function togglePurchased(m: Material) {
    const { error } = await createClient().from('project_materials').update({ is_purchased: !m.is_purchased, actual_cost_cents: !m.is_purchased && m.actual_cost_cents === null ? m.est_cost_cents : m.actual_cost_cents }).eq('id', m.id);
    if (error) return toastError(describeDbError(error));
  }

  async function deleteMaterial(m: Material) {
    const { error } = await createClient().from('project_materials').delete().eq('id', m.id);
    if (error) return toastError(describeDbError(error));
    success('Material removed');
  }

  async function suggestMaterials() {
    const t = templates[0];
    if (!t) return toastError('No starter scope matches this project — add materials by hand.');
    const have = new Set(materials.map((m) => m.name.toLowerCase()));
    const fresh = t.materials.filter((m) => !have.has(m.name.toLowerCase()));
    if (!fresh.length) return toastError('Every suggested material is already listed.');
    setSuggesting(true);
    const { error } = await createClient().from('project_materials').insert(fresh.map((m) => ({ family_id: familyId, project_id: project.id, name: m.name, quantity: m.quantity, unit: m.unit ?? null, est_cost_cents: m.estCents, created_by: userId })));
    setSuggesting(false);
    if (error) return toastError(describeDbError(error));
    success(`${fresh.length} material${fresh.length === 1 ? '' : 's'} added`);
  }

  async function setQuoteStatus(q: Quote, status: ProjectQuoteStatus) {
    const supabase = createClient();
    if (status === 'accepted') {
      // One accepted quote per project: demote any other accepted quote first.
      const others = quotes.filter((x) => x.id !== q.id && x.status === 'accepted');
      if (others.length) {
        const { error: demoteError } = await supabase.from('project_quotes').update({ status: 'declined' }).in('id', others.map((x) => x.id));
        if (demoteError) return toastError(describeDbError(demoteError));
      }
    }
    const { error } = await supabase.from('project_quotes').update({ status }).eq('id', q.id);
    if (error) return toastError(describeDbError(error));
    if (status === 'accepted') {
      const { error: linkError } = await supabase.from('home_projects').update({ contractor_id: q.contractor_id ?? project.contractor_id, status: project.status === 'quoting' || project.status === 'planning' || project.status === 'idea' ? 'scheduled' : project.status }).eq('id', project.id);
      if (linkError) toastError(describeDbError(linkError));
      success(`Accepted ${q.contractor_name} at ${money(q.amount_cents)}`);
    }
  }

  async function deleteQuote(q: Quote) {
    const { error } = await createClient().from('project_quotes').delete().eq('id', q.id);
    if (error) return toastError(describeDbError(error));
    success('Quote removed');
  }

  const nextStatuses: HomeProjectStatus[] = project.status === 'done' || project.status === 'cancelled' ? ['planning'] : project.status === 'idea' ? ['planning', 'cancelled'] : project.status === 'in_progress' ? ['done', 'on_hold'] : project.status === 'scheduled' ? ['in_progress', 'on_hold'] : project.status === 'on_hold' ? ['planning', 'cancelled'] : ['quoting', 'scheduled', 'in_progress', 'done'];

  return (
    <Modal open title={`${kindMeta(project.kind).emoji} ${project.title}`} description={`${statusLabel(project.status)} · ${project.priority} priority${project.room ? ` · ${project.room}` : ''} · ${project.is_diy ? 'DIY' : 'hiring'}`} onClose={onClose} className="max-w-3xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {nextStatuses.map((s) => <Button key={s} size="sm" variant={s === 'done' ? 'primary' : 'secondary'} onClick={() => onStatus(s)}>{s === 'done' ? <Check className="h-3.5 w-3.5" /> : s === 'cancelled' ? <XCircle className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />} {statusLabel(s)}</Button>)}
          <span className="ml-auto flex items-center gap-1">
            <button onClick={onEdit} aria-label={tr('projects.editProject')} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
            <button onClick={onDelete} aria-label={tr('projects.deleteProject')} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
          </span>
        </div>

        {project.description && <p className="text-sm text-muted">{project.description}</p>}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className={cn('rounded-xl border p-3', bh.status === 'over' ? 'border-rose-500/30 bg-rose-500/10' : bh.status === 'near' ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/60')}>
            <p className="text-xs text-muted">{tr('projects.budget')}</p>
            <p className="text-lg font-bold">{bh.status === 'no_budget' ? money(bh.forecastCents) : `${bh.pct}%`}</p>
            <p className="text-[11px] text-muted">{bh.status === 'no_budget' ? 'forecast · no budget set' : `${money(bh.forecastCents)} forecast of ${money(project.budget_cents)} · ${money(bh.committedCents)} committed`}</p>
          </div>
          <div className={cn('rounded-xl border p-3', sc.state === 'overdue' ? 'border-rose-500/30 bg-rose-500/10' : 'border-border bg-surface/60')}>
            <p className="text-xs text-muted">{tr('projects.schedule')}</p>
            <p className="text-lg font-bold">{sc.state === 'none' ? '—' : sc.state === 'done' ? 'Done' : sc.state === 'overdue' ? `${-(sc.days ?? 0)}d over` : `${sc.days}d`}</p>
            <p className="text-[11px] text-muted">{project.target_start ? `${fmtDate(project.target_start)}${project.target_end ? ` → ${fmtDate(project.target_end)}` : ''}` : 'No dates yet'}</p>
          </div>
          <div className="rounded-xl border border-brand/20 bg-brand/5 p-3">
            <p className="text-xs text-brand-text">{tr('projects.next')}</p>
            <p className="text-sm font-medium">{nextAction(project, materials, quotes, today)}</p>
            {project.contractor_id && contractorOf(project.contractor_id) && <p className="text-[11px] text-muted">Pro: {contractorOf(project.contractor_id)?.name}{contractorOf(project.contractor_id)?.phone ? ` · ${contractorOf(project.contractor_id)?.phone}` : ''}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-border" role="tablist">
          <button role="tab" aria-selected={tab === 'materials'} onClick={() => setTab('materials')} className={cn('-mb-px border-b-2 px-3 py-2 text-sm coarse:min-h-11', tab === 'materials' ? 'border-brand text-brand-text' : 'border-transparent text-muted hover:text-fg')}>{tr('projects.materials')}{mt.count})</button>
          <button role="tab" aria-selected={tab === 'quotes'} onClick={() => setTab('quotes')} className={cn('-mb-px border-b-2 px-3 py-2 text-sm coarse:min-h-11', tab === 'quotes' ? 'border-brand text-brand-text' : 'border-transparent text-muted hover:text-fg')}>{tr('projects.quotes')}{quotes.length})</button>
          <span className="ml-auto flex items-center gap-1 pb-1">
            {tab === 'materials' && templates.length > 0 && <Button size="sm" variant="secondary" onClick={suggestMaterials} loading={suggesting}><Wand2 className="h-3.5 w-3.5" /> {tr('projects.suggest')}</Button>}
            {tab === 'materials' ? <Button size="sm" onClick={() => setMaterialForm({ open: true, material: null })}><Plus className="h-3.5 w-3.5" /> {tr('projects.material')}</Button> : <Button size="sm" onClick={() => setQuoteForm({ open: true, quote: null })}><Plus className="h-3.5 w-3.5" /> {tr('projects.quote')}</Button>}
          </span>
        </div>

        {tab === 'materials' && (
          materials.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">{tr('projects.noMaterialsYet')}{templates.length ? ' “Suggest” fills the list from the matching starter scope.' : ''}</p>
          ) : (
            <ul className="space-y-1.5">
              {materials.map((m) => (
                <li key={m.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2', m.is_purchased ? 'border-border/60 bg-surface/30' : 'border-border bg-surface/60')}>
                  <button onClick={() => togglePurchased(m)} aria-label={m.is_purchased ? `Mark ${m.name} not purchased` : `Mark ${m.name} purchased`} className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full border coarse:h-8 coarse:w-8', m.is_purchased ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border hover:border-brand')}>{m.is_purchased ? <Check className="h-3.5 w-3.5" /> : <ShoppingCart className="h-3 w-3 text-muted" />}</button>
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-sm', m.is_purchased && 'text-muted line-through')}>{m.name} <span className="text-xs text-muted">×{m.quantity}{m.unit ? ` ${m.unit}` : ''}</span></p>
                    <p className="text-[11px] text-muted">{money(materialLineCents(m))}{m.is_purchased && m.actual_cost_cents !== null && m.est_cost_cents !== null && m.actual_cost_cents !== m.est_cost_cents ? ` (est. ${money(Math.round(m.est_cost_cents * m.quantity))})` : ''}{m.store ? ` · ${m.store}` : ''}</p>
                  </div>
                  {m.url && <a href={m.url} target="_blank" rel="noreferrer" aria-label={tr('projects.openLink')} className="rounded-lg p-1.5 text-muted hover:text-fg"><ExternalLink className="h-4 w-4" /></a>}
                  <button onClick={() => setMaterialForm({ open: true, material: m })} aria-label={`Edit ${m.name}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => deleteMaterial(m)} aria-label={`Delete ${m.name}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
              <li className="flex justify-between px-3 pt-1 text-xs text-muted"><span>{mt.purchased}/{mt.count} {tr('projects.bought')} {money(mt.actualCents)} spent</span><span>{money(mt.remainingCents)} {tr('projects.stillToBuy')}</span></li>
            </ul>
          )
        )}

        {tab === 'quotes' && (
          quotes.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">{tr('projects.noQuotesYetThreeIsThe')}</p>
          ) : (
            <ul className="space-y-1.5">
              {qc.spreadPct !== null && <li className="px-1 text-xs text-muted">{tr('projects.liveQuotesSpan')} {qc.spreadPct}{tr('projects.fromLowestToHighest')}{qc.lowest ? ` · lowest ${money(qc.lowest.amount_cents)} (${qc.lowest.contractor_name})` : ''}</li>}
              {qc.rows.map((q) => {
                const c = contractorOf(q.contractor_id);
                return (
                  <li key={q.id} className={cn('rounded-xl border px-3 py-2', q.status === 'accepted' ? 'border-emerald-500/30 bg-emerald-500/10' : q.isExpired || q.status === 'declined' ? 'border-border/60 bg-surface/30 opacity-75' : 'border-border bg-surface/60')}>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{q.contractor_name}{c?.is_preferred ? ' ⭐' : ''} <span className="font-bold">{q.status === 'requested' ? '' : money(q.amount_cents)}</span>{q.isLowest && q.status !== 'accepted' ? <span className="ml-1 rounded-full bg-brand/15 px-1.5 text-[10px] text-brand-text">lowest</span> : null}{q.vsLowestPct ? <span className="ml-1 text-xs text-muted">+{q.vsLowestPct}%</span> : null}</p>
                        <p className="text-[11px] text-muted">{QUOTE_STATUSES.find((s) => s.value === q.status)?.label}{q.isExpired && q.status !== 'expired' ? ' · expired' : ''}{q.includes_materials ? ' · incl. materials' : ' · labour only'}{q.lead_time_days !== null ? ` · ${q.lead_time_days}d lead` : ''}{q.valid_until ? ` · valid to ${fmtDate(q.valid_until)}` : ''}{c?.phone ? ` · ${c.phone}` : ''}</p>
                        {q.notes && <p className="mt-0.5 text-[11px] text-muted">{q.notes}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {q.status === 'requested' && <Button size="sm" variant="secondary" onClick={() => setQuoteForm({ open: true, quote: q })}>{tr('projects.received')}</Button>}
                        {q.status === 'received' && !q.isExpired && <Button size="sm" onClick={() => setQuoteStatus(q, 'accepted')}>{tr('projects.accept')}</Button>}
                        {q.status === 'received' && <button onClick={() => setQuoteStatus(q, 'declined')} aria-label={tr('projects.declineQuote')} className="rounded-lg p-1.5 text-muted hover:text-fg"><XCircle className="h-4 w-4" /></button>}
                        {q.status === 'accepted' && <button onClick={() => setQuoteStatus(q, 'received')} className="text-xs text-muted hover:text-fg">{tr('projects.undo')}</button>}
                        <button onClick={() => setQuoteForm({ open: true, quote: q })} aria-label={tr('projects.editQuote')} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                        <button onClick={() => deleteQuote(q)} aria-label={tr('projects.deleteQuote')} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        )}

        {materialForm.open && <MaterialForm familyId={familyId} userId={userId} projectId={project.id} material={materialForm.material} onClose={() => setMaterialForm({ open: false, material: null })} onSaved={() => { setMaterialForm({ open: false, material: null }); success('Material saved'); }} />}
        {quoteForm.open && <QuoteForm familyId={familyId} userId={userId} projectId={project.id} contractors={contractors} quote={quoteForm.quote} onClose={() => setQuoteForm({ open: false, quote: null })} onSaved={() => { setQuoteForm({ open: false, quote: null }); success('Quote saved'); }} />}
      </div>
    </Modal>
  );
}

function MaterialForm({ familyId, userId, projectId, material, onClose, onSaved }: { familyId: string; userId: string; projectId: string; material: Material | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [purchased, setPurchased] = useState(material?.is_purchased ?? false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return toastError('Name the material');
    const quantity = Math.max(0.01, Number(f.get('quantity') ?? 1) || 1);
    setLoading(true);
    const payload = {
      name, quantity, unit: String(f.get('unit') ?? '').trim() || null, est_cost_cents: dollarsToCents(f.get('est')), actual_cost_cents: dollarsToCents(f.get('actual')),
      is_purchased: purchased, store: String(f.get('store') ?? '').trim() || null, url: String(f.get('url') ?? '').trim() || null, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = material
      ? await supabase.from('project_materials').update(payload).eq('id', material.id)
      : await supabase.from('project_materials').insert({ family_id: familyId, project_id: projectId, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={material ? 'Edit material' : 'Add material'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('projects.material')} required>{(id) => <Input id={id} name="name" defaultValue={material?.name ?? ''} placeholder={tr('projects.interiorPaintGallon')} autoFocus />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Qty">{(id) => <Input id={id} name="quantity" type="number" min={0.01} step={0.5} defaultValue={material?.quantity ?? 1} />}</Field>
          <Field label={tr('projects.unit')}>{(id) => <Input id={id} name="unit" defaultValue={material?.unit ?? ''} placeholder={tr('projects.galSqFt')} />}</Field>
          <Field label={tr('projects.estUnitCost')}>{(id) => <Input id={id} name="est" type="number" min={0} step={0.5} defaultValue={centsToDollars(material?.est_cost_cents)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('projects.actualUnitCost')}>{(id) => <Input id={id} name="actual" type="number" min={0} step={0.5} defaultValue={centsToDollars(material?.actual_cost_cents)} />}</Field>
          <Field label={tr('projects.store')}>{(id) => <Input id={id} name="store" defaultValue={material?.store ?? ''} placeholder={tr('projects.hardwareStore')} />}</Field>
        </div>
        <Field label={tr('projects.link')}>{(id) => <Input id={id} name="url" type="url" defaultValue={material?.url ?? ''} placeholder="https://" />}</Field>
        <button type="button" aria-pressed={purchased} onClick={() => setPurchased(!purchased)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', purchased ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{tr('projects.purchased')}</button>
        <Field label={tr('projects.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={material?.notes ?? ''} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('projects.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('projects.saveMaterial')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function QuoteForm({ familyId, userId, projectId, contractors, quote, onClose, onSaved }: { familyId: string; userId: string; projectId: string; contractors: Contractor[]; quote: Quote | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [contractorId, setContractorId] = useState(quote?.contractor_id ?? '');
  const [includesMaterials, setIncludesMaterials] = useState(quote?.includes_materials ?? false);
  const chosen = contractors.find((c) => c.id === contractorId) ?? null;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const contractorName = String(f.get('contractor_name') ?? '').trim() || chosen?.name || '';
    if (!contractorName) return toastError('Who is the quote from?');
    const status = String(f.get('status') ?? 'received') as ProjectQuoteStatus;
    const amount = dollarsToCents(f.get('amount'));
    if (status !== 'requested' && amount === null) return toastError('Enter the quoted amount');
    setLoading(true);
    const payload = {
      contractor_id: contractorId || null, contractor_name: contractorName, amount_cents: amount ?? 0, includes_materials: includesMaterials,
      lead_time_days: String(f.get('lead_time_days') ?? '') ? Math.max(0, Number(f.get('lead_time_days'))) : null, valid_until: String(f.get('valid_until') ?? '') || null,
      status, received_on: status === 'requested' ? null : (String(f.get('received_on') ?? '') || isoDate(new Date())), notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = quote
      ? await supabase.from('project_quotes').update(payload).eq('id', quote.id)
      : await supabase.from('project_quotes').insert({ family_id: familyId, project_id: projectId, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={quote ? 'Edit quote' : 'Log a quote'} description="From your contractor book or anyone new. Log requested quotes too, so you know who owes you a number." onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('projects.fromYourContractorBook')}>{(id) => <Select id={id} name="contractor_id" value={contractorId} onChange={(e) => setContractorId(e.target.value)}><option value="">{tr('projects.someoneNew')}</option>{contractors.map((c) => <option key={c.id} value={c.id}>{c.is_preferred ? '⭐ ' : ''}{c.name}{c.company ? ` · ${c.company}` : ''}{c.trade ? ` (${c.trade})` : ''}</option>)}</Select>}</Field>
        <Field label={tr('projects.contractorName')} required={!chosen}>{(id) => <Input id={id} name="contractor_name" defaultValue={quote?.contractor_name ?? ''} placeholder={chosen?.name ?? 'Bell Plumbing'} />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('projects.amount')}>{(id) => <Input id={id} name="amount" type="number" min={0} step={10} defaultValue={centsToDollars(quote?.amount_cents)} />}</Field>
          <Field label={tr('projects.status')}>{(id) => <Select id={id} name="status" defaultValue={quote?.status === 'requested' ? 'received' : (quote?.status ?? 'received')}>{QUOTE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
          <Field label={tr('projects.leadTimeDays')}>{(id) => <Input id={id} name="lead_time_days" type="number" min={0} defaultValue={quote?.lead_time_days ?? ''} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('projects.receivedOn')}>{(id) => <Input id={id} name="received_on" type="date" defaultValue={quote?.received_on ?? isoDate(new Date())} />}</Field>
          <Field label={tr('projects.validUntil')}>{(id) => <Input id={id} name="valid_until" type="date" defaultValue={quote?.valid_until ?? ''} />}</Field>
        </div>
        <button type="button" aria-pressed={includesMaterials} onClick={() => setIncludesMaterials(!includesMaterials)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', includesMaterials ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}><Package className="mr-1 inline h-3.5 w-3.5" />{tr('projects.includesMaterials')}</button>
        <Field label={tr('projects.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={quote?.notes ?? ''} placeholder={tr('projects.twoDayJobNeedsTheWater')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('projects.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('projects.saveQuote')}</Button>
        </div>
      </form>
    </Modal>
  );
}
