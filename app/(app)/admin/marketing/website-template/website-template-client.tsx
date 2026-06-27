'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, Pencil, Trash2, X, Globe, Eye, Sparkles, ExternalLink,
  ChevronDown, ChevronRight, Wand2, Check, Copy, LayoutTemplate,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { renderPage, type SeoTemplate, type FeatureBlock, type FaqItem } from '@/lib/seo/template';
import { US_STATES, stateVars } from '@/lib/seo/states';
import { SEO_PRESETS, type SeoPreset } from '@/lib/seo/presets';
import {
  upsertTemplateAction, deleteTemplateAction, duplicateTemplateAction, generatePagesAction,
  setPageStatusAction, deletePagesAction, setTemplatePagesStatusAction,
} from './actions';

export type PageView = { id: string; slug: string; variables: Record<string, string>; status: 'draft' | 'published'; views: number };
export type TemplateView = {
  id: string; name: string; topic: string | null; slugPattern: string;
  eyebrow: string | null; h1Template: string; subheadTemplate: string | null;
  metaTitleTemplate: string | null; metaDescriptionTemplate: string | null; introTemplate: string | null;
  featureBlocks: FeatureBlock[]; faqs: FaqItem[];
  ctaLabel: string | null; ctaHref: string; staticVars: Record<string, string>; isActive: boolean;
  pages: PageView[];
};

const input = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus:border-brand/50 focus:outline-none';
const area = 'w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus:border-brand/50 focus:outline-none';
const label = 'mb-1 block text-xs font-medium text-muted';

export function WebsiteTemplateClient({ templates }: { templates: TemplateView[] }) {
  const [editing, setEditing] = useState<TemplateView | null>(null);
  const [creating, setCreating] = useState<SeoPreset | 'blank' | null>(null);
  const [picking, setPicking] = useState(false);
  const [generating, setGenerating] = useState<TemplateView | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Page templates <span className="text-muted">· {templates.length}</span></h2>
        <button onClick={() => setPicking(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90">
          <Plus className="h-4 w-4" /> New template
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-12 text-center">
          <Globe className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="font-semibold text-fg">No website templates yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Start from a ready-made template — Family Organizer, Chore App, Meal Planner — and
            generate a landing page for all 50 states in a click.
          </p>
          <button onClick={() => setPicking(true)} className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90">
            <Plus className="h-4 w-4" /> New template
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} onEdit={() => setEditing(t)} onGenerate={() => setGenerating(t)} />
          ))}
        </div>
      )}

      {picking && (
        <PresetPicker
          onPick={(p) => { setPicking(false); setCreating(p); }}
          onClose={() => setPicking(false)}
        />
      )}
      {(editing || creating) && (
        <TemplateEditor
          template={editing}
          preset={creating && creating !== 'blank' ? creating : null}
          onClose={() => { setEditing(null); setCreating(null); }}
        />
      )}
      {generating && <GenerateModal template={generating} onClose={() => setGenerating(null)} />}
    </div>
  );
}

function PresetPicker({ onPick, onClose }: { onPick: (p: SeoPreset | 'blank') => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-bg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-fg">Start a new website template</h3>
            <p className="text-xs text-muted">Pick a ready-made starting point or start from scratch.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {SEO_PRESETS.map((p) => (
            <button key={p.id} onClick={() => onPick(p)} className="rounded-xl border border-border bg-surface/40 p-4 text-left transition hover:border-brand/40 hover:bg-surface/70">
              <div className="flex items-center gap-2">
                <LayoutTemplate className="h-4 w-4 text-brand" />
                <p className="font-semibold text-fg">{p.label}</p>
              </div>
              <p className="mt-1 text-xs text-muted">{p.description}</p>
              <p className="mt-2 font-mono text-[10px] text-muted">/{p.draft.slugPattern}</p>
            </button>
          ))}
          <button onClick={() => onPick('blank')} className="flex flex-col items-start justify-center rounded-xl border border-dashed border-border p-4 text-left transition hover:border-brand/40">
            <div className="flex items-center gap-2"><Plus className="h-4 w-4 text-muted" /><p className="font-semibold text-fg">Start from scratch</p></div>
            <p className="mt-1 text-xs text-muted">A blank template you fill in yourself.</p>
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ template, onEdit, onGenerate }: { template: TemplateView; onEdit: () => void; onGenerate: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const published = template.pages.filter((p) => p.status === 'published').length;
  const draft = template.pages.length - published;

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((s) => s.size === template.pages.length ? new Set() : new Set(template.pages.map((p) => p.id)));
  }

  async function bulk(action: 'publish' | 'unpublish' | 'delete') {
    const ids = [...selected];
    if (ids.length === 0) return toastError('Select pages first.');
    setBusy(true);
    const res = action === 'delete'
      ? await deletePagesAction({ ids })
      : await setPageStatusAction({ ids, status: action === 'publish' ? 'published' : 'draft' });
    setBusy(false);
    if (!res.ok) return toastError(res.error ?? 'Failed');
    success(action === 'delete' ? 'Pages deleted' : action === 'publish' ? 'Pages published' : 'Pages unpublished');
    setSelected(new Set());
    router.refresh();
  }

  async function publishAll(status: 'draft' | 'published') {
    setBusy(true);
    const res = await setTemplatePagesStatusAction({ templateId: template.id, status });
    setBusy(false);
    if (!res.ok) return toastError(res.error ?? 'Failed');
    success(status === 'published' ? 'All pages published' : 'All pages unpublished');
    router.refresh();
  }

  async function remove() {
    if (!confirm(`Delete template "${template.name}" and its ${template.pages.length} page(s)? This can't be undone.`)) return;
    setBusy(true);
    const res = await deleteTemplateAction({ id: template.id });
    setBusy(false);
    if (!res.ok) return toastError(res.error ?? 'Failed');
    success('Template deleted');
    router.refresh();
  }

  async function duplicate() {
    setBusy(true);
    const res = await duplicateTemplateAction({ id: template.id });
    setBusy(false);
    if (!res.ok) return toastError(res.error ?? 'Failed');
    success('Template duplicated (inactive) — edit and activate it');
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-fg">{template.name}</p>
            {!template.isActive && <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-muted">inactive</span>}
          </div>
          <p className="truncate font-mono text-xs text-muted">/{template.slugPattern}</p>
          <p className="mt-0.5 text-xs text-muted">
            {template.pages.length} page{template.pages.length === 1 ? '' : 's'} ·{' '}
            <span className="text-emerald-500">{published} live</span>{draft > 0 && <> · {draft} draft</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={onGenerate} className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/20">
            <Wand2 className="h-3.5 w-3.5" /> Generate pages
          </button>
          {template.pages.length > 0 && (
            <button onClick={() => setExpanded((v) => !v)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:text-fg">
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Pages
            </button>
          )}
          <button onClick={onEdit} aria-label="Edit template" title="Edit" className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-4 w-4" /></button>
          <button onClick={duplicate} disabled={busy} aria-label="Duplicate template" title="Duplicate" className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"><Copy className="h-4 w-4" /></button>
          <button onClick={remove} disabled={busy} aria-label="Delete template" title="Delete" className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>

      {expanded && template.pages.length > 0 && (
        <div className="border-t border-border">
          <div className="flex flex-wrap items-center gap-2 bg-surface/30 px-4 py-2 text-xs">
            <button onClick={toggleAll} className="rounded-md border border-border px-2 py-1 text-muted hover:text-fg">
              {selected.size === template.pages.length ? 'Clear' : 'Select all'}
            </button>
            <span className="text-muted">{selected.size} selected</span>
            <div className="ml-auto flex gap-1.5">
              <button onClick={() => bulk('publish')} disabled={busy} className="rounded-md bg-emerald-500/10 px-2 py-1 font-medium text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-50">Publish</button>
              <button onClick={() => bulk('unpublish')} disabled={busy} className="rounded-md bg-surface px-2 py-1 font-medium text-muted hover:text-fg disabled:opacity-50">Unpublish</button>
              <button onClick={() => bulk('delete')} disabled={busy} className="rounded-md bg-red-500/10 px-2 py-1 font-medium text-red-500 hover:bg-red-500/20 disabled:opacity-50">Delete</button>
              <button onClick={() => publishAll('published')} disabled={busy} className="rounded-md border border-border px-2 py-1 font-medium text-muted hover:text-fg disabled:opacity-50">Publish all</button>
            </div>
          </div>
          <div className="max-h-80 divide-y divide-border overflow-auto">
            {template.pages.map((p) => (
              <div key={p.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="accent-brand" aria-label={`Select ${p.slug}`} />
                <span className="font-mono text-xs text-muted">/{p.slug}</span>
                <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', p.status === 'published' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-surface text-muted')}>
                  {p.status}
                </span>
                {p.views > 0 && <span className="text-[10px] text-muted">{p.views} views</span>}
                {p.status === 'published' && (
                  <a href={`/${p.slug}`} target="_blank" rel="noreferrer" className="ml-auto text-muted hover:text-brand" aria-label="Open page"><ExternalLink className="h-3.5 w-3.5" /></a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Generate modal: pick states, publish toggle ──────────────────────────────
const REGIONS: Record<string, string[]> = {
  West: ['CA', 'OR', 'WA', 'NV', 'AZ', 'CO', 'UT', 'ID', 'MT', 'WY', 'NM', 'AK', 'HI'],
  Midwest: ['IL', 'IN', 'IA', 'KS', 'MI', 'MN', 'MO', 'NE', 'ND', 'OH', 'SD', 'WI'],
  South: ['AL', 'AR', 'FL', 'GA', 'KY', 'LA', 'MS', 'NC', 'OK', 'SC', 'TN', 'TX', 'VA', 'WV', 'DC', 'MD', 'DE'],
  Northeast: ['CT', 'ME', 'MA', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT'],
};

function GenerateModal({ template, onClose }: { template: TemplateView; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const existing = useMemo(() => new Set(template.pages.map((p) => p.variables.state_abbr).filter(Boolean)), [template.pages]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(US_STATES.map((s) => s.abbr).filter((a) => !existing.has(a))));
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customKey, setCustomKey] = useState('');
  const [customValuesText, setCustomValuesText] = useState('');
  const [combine, setCombine] = useState(true);

  const customValues = useMemo(
    () => [...new Set(customValuesText.split(/[\n,]/).map((v) => v.trim()).filter(Boolean))],
    [customValuesText],
  );
  const customActive = customOpen && customKey.trim().length > 0 && customValues.length > 0;
  const estimate = customActive
    ? (combine && selected.size > 0 ? selected.size * customValues.length : customValues.length)
    : selected.size;

  function toggle(abbr: string) {
    setSelected((s) => { const n = new Set(s); n.has(abbr) ? n.delete(abbr) : n.add(abbr); return n; });
  }
  function selectAll() { setSelected(new Set(US_STATES.map((s) => s.abbr))); }
  function selectNone() { setSelected(new Set()); }
  function selectRegion(abbrs: string[]) { setSelected((s) => new Set([...s, ...abbrs])); }

  async function generate() {
    if (estimate === 0) return toastError('Pick states or add custom criteria values.');
    setBusy(true);
    const res = await generatePagesAction({
      templateId: template.id,
      stateAbbrs: [...selected],
      custom: customActive ? { key: customKey.trim(), values: customValues } : null,
      combineWithStates: combine,
      publish,
    });
    setBusy(false);
    if (!res.ok) return toastError(res.error ?? 'Failed');
    success(`Generated ${res.created ?? 0} page${res.created === 1 ? '' : 's'}${res.skipped ? ` · ${res.skipped} skipped` : ''}`);
    onClose();
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-bg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h3 className="font-bold text-fg">Generate pages</h3>
            <p className="text-xs text-muted">{template.name} · /{template.slugPattern}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2 text-xs">
          <button onClick={selectAll} className="rounded-md border border-border px-2 py-1 text-muted hover:text-fg">All 50 + DC</button>
          <button onClick={selectNone} className="rounded-md border border-border px-2 py-1 text-muted hover:text-fg">None</button>
          {Object.entries(REGIONS).map(([name, abbrs]) => (
            <button key={name} onClick={() => selectRegion(abbrs)} className="rounded-md border border-border px-2 py-1 text-muted hover:text-fg">+ {name}</button>
          ))}
          <span className="ml-auto self-center font-medium text-brand">{selected.size} selected</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 overflow-auto p-4 sm:grid-cols-3">
          {US_STATES.map((s) => {
            const on = selected.has(s.abbr);
            const already = existing.has(s.abbr);
            return (
              <button key={s.abbr} onClick={() => toggle(s.abbr)}
                className={cn('flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-xs transition',
                  on ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:border-brand/40')}>
                <span className={cn('grid h-3.5 w-3.5 shrink-0 place-items-center rounded border', on ? 'border-brand bg-brand text-white' : 'border-border')}>
                  {on && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="truncate">{s.name}</span>
                {already && <span className="ml-auto text-[9px] text-muted">exists</span>}
              </button>
            );
          })}
        </div>

        {/* Optional second dimension — "other criteria you decide" */}
        <div className="border-t border-border px-4 py-3">
          <button onClick={() => setCustomOpen((v) => !v)} className="flex w-full items-center justify-between text-xs font-medium text-muted hover:text-fg">
            <span className="flex items-center gap-1.5"><Plus className="h-3.5 w-3.5" /> Add custom criteria (cities, audiences, use-cases…)</span>
            {customOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          {customOpen && (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <div className="w-32">
                  <input className={cn(input, 'h-9 font-mono')} value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="city" />
                  <p className="mt-1 text-[10px] text-muted">variable name</p>
                </div>
                <div className="flex-1">
                  <textarea className={cn(area, 'min-h-0')} rows={3} value={customValuesText} onChange={(e) => setCustomValuesText(e.target.value)} placeholder="Los Angeles, San Francisco, San Diego…" />
                  <p className="mt-1 text-[10px] text-muted">{customValues.length} value{customValues.length === 1 ? '' : 's'} · comma or newline separated</p>
                </div>
              </div>
              {customKey.trim() && (
                <p className="text-[11px] text-muted">
                  Use <code className="text-brand">{`{${customKey.trim().toLowerCase()}}`}</code> and{' '}
                  <code className="text-brand">{`{${customKey.trim().toLowerCase()}_slug}`}</code> in your template &amp; slug pattern.
                </p>
              )}
              {selected.size > 0 && customValues.length > 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} className="accent-brand" />
                  Combine with selected states (every state × every value)
                </label>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} className="accent-brand" />
            Publish immediately
          </label>
          <button onClick={generate} disabled={busy || estimate === 0} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
            <Wand2 className="h-4 w-4" /> {busy ? 'Generating…' : `Generate ${estimate}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Template editor with live preview ────────────────────────────────────────
type Draft = {
  name: string; topic: string; slugPattern: string; eyebrow: string;
  h1Template: string; subheadTemplate: string; metaTitleTemplate: string; metaDescriptionTemplate: string;
  introTemplate: string; featureBlocks: FeatureBlock[]; faqs: FaqItem[];
  ctaLabel: string; ctaHref: string; staticVars: Array<{ k: string; v: string }>; isActive: boolean;
};

const BLANK_DRAFT: Draft = {
  name: '', topic: '', slugPattern: 'topic/{state_slug}', eyebrow: '{product} · {state}',
  h1Template: '', subheadTemplate: '', metaTitleTemplate: '', metaDescriptionTemplate: '',
  introTemplate: '', featureBlocks: [], faqs: [], ctaLabel: 'Get started free', ctaHref: '/signup',
  staticVars: [{ k: 'product', v: 'Bubaly' }], isActive: true,
};

function presetToDraft(p: SeoPreset): Draft {
  return {
    ...p.draft,
    staticVars: Object.entries(p.draft.staticVars).map(([k, v]) => ({ k, v })),
    isActive: true,
  };
}

function toDraft(t: TemplateView | null, preset: SeoPreset | null): Draft {
  if (t) return {
    name: t.name, topic: t.topic ?? '', slugPattern: t.slugPattern, eyebrow: t.eyebrow ?? '',
    h1Template: t.h1Template, subheadTemplate: t.subheadTemplate ?? '',
    metaTitleTemplate: t.metaTitleTemplate ?? '', metaDescriptionTemplate: t.metaDescriptionTemplate ?? '',
    introTemplate: t.introTemplate ?? '', featureBlocks: t.featureBlocks.length ? t.featureBlocks : [],
    faqs: t.faqs.length ? t.faqs : [], ctaLabel: t.ctaLabel ?? '', ctaHref: t.ctaHref || '/signup',
    staticVars: Object.entries(t.staticVars ?? {}).map(([k, v]) => ({ k, v })), isActive: t.isActive,
  };
  if (preset) return presetToDraft(preset);
  return BLANK_DRAFT;
}

function TemplateEditor({ template, preset, onClose }: { template: TemplateView | null; preset: SeoPreset | null; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [d, setD] = useState<Draft>(() => toDraft(template, preset));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  // Live preview against California.
  const preview = useMemo(() => {
    const staticVars = Object.fromEntries(d.staticVars.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v]));
    const tpl: SeoTemplate = {
      id: 'preview', name: d.name, topic: d.topic || null, slug_pattern: d.slugPattern,
      eyebrow: d.eyebrow || null, h1_template: d.h1Template, subhead_template: d.subheadTemplate || null,
      meta_title_template: d.metaTitleTemplate || null, meta_description_template: d.metaDescriptionTemplate || null,
      intro_template: d.introTemplate || null, feature_blocks: d.featureBlocks, faqs: d.faqs,
      cta_label: d.ctaLabel || null, cta_href: d.ctaHref || '/signup', static_vars: staticVars, is_active: d.isActive,
    };
    return renderPage(tpl, stateVars(US_STATES.find((s) => s.abbr === 'CA')!));
  }, [d]);

  async function save() {
    setSaving(true);
    const res = await upsertTemplateAction({
      id: template?.id, name: d.name, topic: d.topic || null, slugPattern: d.slugPattern,
      eyebrow: d.eyebrow || null, h1Template: d.h1Template, subheadTemplate: d.subheadTemplate || null,
      metaTitleTemplate: d.metaTitleTemplate || null, metaDescriptionTemplate: d.metaDescriptionTemplate || null,
      introTemplate: d.introTemplate || null, featureBlocks: d.featureBlocks.filter((f) => f.title.trim()),
      faqs: d.faqs.filter((f) => f.q.trim()), ctaLabel: d.ctaLabel || null, ctaHref: d.ctaHref || '/signup',
      staticVars: Object.fromEntries(d.staticVars.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v])),
      isActive: d.isActive,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Save failed');
    success(template ? 'Template updated — every page reflects the change' : 'Template created');
    onClose();
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-2xl border border-border bg-bg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="font-bold text-fg">{template ? 'Edit template' : 'New SEO page template'}</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>

        <div className="grid flex-1 gap-0 overflow-hidden lg:grid-cols-2">
          {/* Form */}
          <div className="space-y-4 overflow-auto p-4">
            <div className="rounded-lg bg-brand/5 p-2.5 text-xs text-muted">
              Use <code className="text-brand">{'{state}'}</code>, <code className="text-brand">{'{state_abbr}'}</code>,
              <code className="text-brand"> {'{state_slug}'}</code>, <code className="text-brand">{'{year}'}</code>, and any static
              variables below. Filters: <code className="text-brand">{'{state:upper}'}</code>.
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div><label className={label}>Template name</label><input className={input} value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="Family Organizer by State" /></div>
              <div><label className={label}>Topic (optional)</label><input className={input} value={d.topic} onChange={(e) => set('topic', e.target.value)} placeholder="family-organizer" /></div>
            </div>
            <div>
              <label className={label}>Slug pattern</label>
              <input className={cn(input, 'font-mono')} value={d.slugPattern} onChange={(e) => set('slugPattern', e.target.value)} placeholder="family-organizer/{state_slug}" />
              {d.slugPattern && !d.slugPattern.includes('{') && (
                <p className="mt-1 text-xs text-amber-500">
                  No variable in the slug — every state resolves to the same URL, so only one page can be generated. Add e.g. <code className="text-brand">{'{state_slug}'}</code>.
                </p>
              )}
              <p className="mt-1 text-[11px] text-muted">Resolves to <span className="font-mono text-fg">/{preview.slug || '…'}</span></p>
            </div>
            <div><label className={label}>Eyebrow</label><input className={input} value={d.eyebrow} onChange={(e) => set('eyebrow', e.target.value)} /></div>
            <div><label className={label}>Headline (H1)</label><input className={input} value={d.h1Template} onChange={(e) => set('h1Template', e.target.value)} /></div>
            <div><label className={label}>Subhead</label><textarea className={area} rows={2} value={d.subheadTemplate} onChange={(e) => set('subheadTemplate', e.target.value)} /></div>
            <div><label className={label}>Intro body (blank line = new paragraph)</label><textarea className={area} rows={4} value={d.introTemplate} onChange={(e) => set('introTemplate', e.target.value)} /></div>

            <div className="grid grid-cols-1 gap-3">
              <div><label className={label}>Meta title</label><input className={input} value={d.metaTitleTemplate} onChange={(e) => set('metaTitleTemplate', e.target.value)} /></div>
              <div><label className={label}>Meta description</label><textarea className={area} rows={2} value={d.metaDescriptionTemplate} onChange={(e) => set('metaDescriptionTemplate', e.target.value)} /></div>
            </div>

            {/* Feature blocks */}
            <RepeatableFeatures features={d.featureBlocks} onChange={(f) => set('featureBlocks', f)} />
            {/* FAQs */}
            <RepeatableFaqs faqs={d.faqs} onChange={(f) => set('faqs', f)} />

            <div className="grid grid-cols-2 gap-3">
              <div><label className={label}>CTA label</label><input className={input} value={d.ctaLabel} onChange={(e) => set('ctaLabel', e.target.value)} placeholder="Get started free" /></div>
              <div><label className={label}>CTA link</label><input className={input} value={d.ctaHref} onChange={(e) => set('ctaHref', e.target.value)} placeholder="/signup" /></div>
            </div>

            {/* Static vars */}
            <RepeatableVars vars={d.staticVars} onChange={(v) => set('staticVars', v)} />

            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={d.isActive} onChange={(e) => set('isActive', e.target.checked)} className="accent-brand" />
              Active (inactive templates hide all their pages)
            </label>
          </div>

          {/* Live preview */}
          <div className="overflow-auto border-t border-border bg-surface/20 p-4 lg:border-l lg:border-t-0">
            <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><Eye className="h-3.5 w-3.5" /> Live preview · California</p>
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-border bg-bg p-3">
                <p className="text-[11px] text-muted">Google result</p>
                <p className="mt-1 truncate text-xs text-emerald-600 dark:text-emerald-400">bubaly.com/{preview.slug}</p>
                <p className="truncate text-base font-medium text-blue-700 dark:text-blue-400">{preview.metaTitle}</p>
                <p className="line-clamp-2 text-xs text-muted">{preview.metaDescription}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg p-4 text-center">
                {preview.eyebrow && <span className="inline-flex rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand">{preview.eyebrow}</span>}
                <h1 className="mt-2 text-xl font-extrabold tracking-tight">{preview.h1}</h1>
                {preview.subhead && <p className="mt-1.5 text-xs text-muted">{preview.subhead}</p>}
                <span className="mt-3 inline-flex rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">{preview.ctaLabel}</span>
              </div>
              {preview.paragraphs.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-border bg-bg p-3 text-xs leading-relaxed text-fg/80">
                  {preview.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
                </div>
              )}
              {preview.features.length > 0 && (
                <div className="grid grid-cols-1 gap-1.5">
                  {preview.features.map((f, i) => (
                    <div key={i} className="rounded-lg border border-border bg-bg p-2.5">
                      <p className="text-xs font-semibold">{f.title}</p>
                      <p className="text-[11px] text-muted">{f.description}</p>
                    </div>
                  ))}
                </div>
              )}
              {preview.faqs.length > 0 && (
                <div className="rounded-lg border border-border bg-bg p-3">
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted">FAQ (AEO structured data)</p>
                  {preview.faqs.map((f, i) => (
                    <div key={i} className="border-t border-border/50 py-1.5 first:border-0 first:pt-0">
                      <p className="text-xs font-medium">{f.q}</p>
                      <p className="text-[11px] text-muted">{f.a}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:text-fg">Cancel</button>
          <button onClick={save} disabled={saving || !d.name.trim()} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
            <Sparkles className="h-4 w-4" /> {saving ? 'Saving…' : template ? 'Save template' : 'Create template'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RepeatableFeatures({ features, onChange }: { features: FeatureBlock[]; onChange: (f: FeatureBlock[]) => void }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className={label}>Feature blocks</label>
        <button type="button" onClick={() => onChange([...features, { icon: 'sparkles', title: '', description: '' }])} className="text-xs font-medium text-brand">+ Add</button>
      </div>
      <div className="space-y-2">
        {features.map((f, i) => (
          <div key={i} className="rounded-lg border border-border p-2 space-y-1.5">
            <div className="flex gap-1.5">
              <input className={cn(input, 'h-8 w-24')} value={f.icon ?? ''} onChange={(e) => onChange(features.map((x, j) => j === i ? { ...x, icon: e.target.value } : x))} placeholder="icon" />
              <input className={cn(input, 'h-8 flex-1')} value={f.title} onChange={(e) => onChange(features.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} placeholder="Title" />
              <button type="button" onClick={() => onChange(features.filter((_, j) => j !== i))} aria-label="Remove" className="rounded-md p-1.5 text-muted hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            <input className={cn(input, 'h-8')} value={f.description} onChange={(e) => onChange(features.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} placeholder="Description" />
          </div>
        ))}
      </div>
    </div>
  );
}

function RepeatableFaqs({ faqs, onChange }: { faqs: FaqItem[]; onChange: (f: FaqItem[]) => void }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className={label}>FAQ (powers AEO structured data)</label>
        <button type="button" onClick={() => onChange([...faqs, { q: '', a: '' }])} className="text-xs font-medium text-brand">+ Add</button>
      </div>
      <div className="space-y-2">
        {faqs.map((f, i) => (
          <div key={i} className="rounded-lg border border-border p-2 space-y-1.5">
            <div className="flex gap-1.5">
              <input className={cn(input, 'h-8 flex-1')} value={f.q} onChange={(e) => onChange(faqs.map((x, j) => j === i ? { ...x, q: e.target.value } : x))} placeholder="Question" />
              <button type="button" onClick={() => onChange(faqs.filter((_, j) => j !== i))} aria-label="Remove" className="rounded-md p-1.5 text-muted hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            <textarea className={cn(area, 'min-h-0')} rows={2} value={f.a} onChange={(e) => onChange(faqs.map((x, j) => j === i ? { ...x, a: e.target.value } : x))} placeholder="Answer" />
          </div>
        ))}
      </div>
    </div>
  );
}

function RepeatableVars({ vars, onChange }: { vars: Array<{ k: string; v: string }>; onChange: (v: Array<{ k: string; v: string }>) => void }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className={label}>Static variables (applied to every page)</label>
        <button type="button" onClick={() => onChange([...vars, { k: '', v: '' }])} className="text-xs font-medium text-brand">+ Add</button>
      </div>
      <div className="space-y-1.5">
        {vars.map((x, i) => (
          <div key={i} className="flex gap-1.5">
            <input className={cn(input, 'h-8 w-32 font-mono')} value={x.k} onChange={(e) => onChange(vars.map((y, j) => j === i ? { ...y, k: e.target.value } : y))} placeholder="key" />
            <input className={cn(input, 'h-8 flex-1')} value={x.v} onChange={(e) => onChange(vars.map((y, j) => j === i ? { ...y, v: e.target.value } : y))} placeholder="value" />
            <button type="button" onClick={() => onChange(vars.filter((_, j) => j !== i))} aria-label="Remove" className="rounded-md p-1.5 text-muted hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
