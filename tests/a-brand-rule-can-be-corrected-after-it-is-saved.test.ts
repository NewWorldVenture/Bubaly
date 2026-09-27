// /admin/marketing/platform's "Brand rules" and "Templates" cards.
//
// Both save actions have always had two branches — `const id = optional(formData,
// 'id')`, then update-by-id or insert. No form on the page ever posted an `id`.
// The cards above each form rendered read-only, there was no per-row editor, no
// delete and no deactivate, and a repo-wide grep finds no other caller. So the
// update branch was dead code and the only affordance for changing an existing
// row was the create form underneath it.
//
// For a brand rule that is a hard dead end, because `rule_key` is UNIQUE
// (0237:81) and service_role does not bypass a table constraint: re-saving the
// corrected rule under the same key raises 23505, which
// lib/supabase/errors.ts turns into "That already exists. Try a different
// value." The correction is discarded. The operator's only remaining move is a
// SECOND rule_key — and `runRegeneration` selects every row with `active = true`
// and concatenates all of them into the prompt, so the stale rule and its
// correction both reach the model, contradicting each other, on every page the
// five-minute worker regenerates and publishes.
//
// For a template it was quieter and arguably worse: no unique key, so the save
// SUCCEEDED, a duplicate row appeared in the list, and nothing on screen said
// which of the two identically-named rows generation actually reads
// (`platform.ts` filters on is_default).
//
// These cases build each submission out of the form the REAL page renders — every
// named field, with the value the browser would post and unchecked checkboxes
// omitted the way HTML omits them — hand it to the REAL server action, and then
// run the REAL regeneration worker to assert what reaches the model that writes
// the public page. A form that stops posting its row's id fails at step one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  prompts: [] as string[],
}));

vi.mock('next/cache', () => ({
  revalidatePath: state.revalidatePath,
  revalidateTag: state.revalidateTag,
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => state.db }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
// The page renders through the REAL lookup over the REAL en-US catalogue, read
// from disk — not a shim that answers a missing key with the key itself, which
// is how five new labels once shipped as raw "platform.saveChanges" text while
// every case here stayed green. translate() still falls back to the key (that is
// production behaviour); the English-copy case below is what goes red on it.
vi.mock('@/lib/i18n/server', async () => {
  const { readFileSync } = await import('node:fs');
  const { translate } = await import('@/lib/i18n/translate');
  const enUS = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(enUS, key, params),
  };
});
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin-1', actorEmail: 'admin@example.test' }),
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string, error: unknown) => {
    throw new Error(`Could not ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  },
}));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    complete: async ({ messages }: { messages: { content: string }[] }) => {
      state.prompts.push(messages.map((message) => message.content).join('\n'));
      return {
        text: JSON.stringify({
          title: 'Meal planning', summary: 'A summary.', body: 'A body.', content: {},
          seo: { title: 'Meal planning | Bubaly', description: 'A summary.', keywords: [], canonical: '/features/meal-planning' },
          aeo: { questions: [{ question: 'How does Bubaly plan meals?', answer: 'A summary.' }] },
        }),
      };
    },
  }),
}));

import { saveMarketingBrandRule, saveMarketingTemplate } from '@/app/(app)/admin/marketing/platform/actions';
import MarketingPlatformPage from '@/app/(app)/admin/marketing/platform/page';
import { processMarketingGenerationJobs } from '@/lib/marketing/platform';

const WRONG = 'Say Bubaly is used by 40,000 families.';
const CORRECTED = 'Never state a customer count. Describe what the product does.';

// ── Rendering the page the way a browser would submit it ─────────────────────
//
// `renderToStaticMarkup` (react-dom 18 in this runner) cannot await an async
// server component, and this page has three. Resolve those in place — only the
// functions that really are async, so the sync client components are left for
// React — then walk the resolved tree for its forms.

async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree)) as Promise<ReactNode>;
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  const type: unknown = element.type;
  if (typeof type === 'function' && type.constructor?.name === 'AsyncFunction') {
    return resolveTree(await (type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  const props = element.props as { children?: ReactNode };
  if (props && props.children !== undefined) {
    return createElement(type as never, { ...props, key: element.key }, await resolveTree(props.children));
  }
  return node;
}

type Field = { name: string; value: string; checkbox: boolean; checked: boolean };
type Form = { action: unknown; fields: Field[] };

const CONTROLS = new Set(['input', 'textarea', 'select']);

function walk(node: ReactNode, visit: (element: ReactElement) => void): void {
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (!isValidElement(node)) return;
  visit(node);
  const props = node.props as { children?: ReactNode };
  if (props?.children !== undefined) walk(props.children, visit);
}

function formsOf(tree: ReactNode): Form[] {
  const forms: Form[] = [];
  walk(tree, (element) => {
    if (element.type !== 'form') return;
    const props = element.props as { action?: unknown; children?: ReactNode };
    const fields: Field[] = [];
    walk(props.children, (control) => {
      if (typeof control.type !== 'string' || !CONTROLS.has(control.type)) return;
      const attrs = control.props as { name?: string; type?: string; value?: unknown; defaultValue?: unknown; defaultChecked?: boolean };
      if (!attrs.name) return;
      fields.push({
        name: attrs.name,
        value: String(attrs.value ?? attrs.defaultValue ?? ''),
        checkbox: attrs.type === 'checkbox',
        checked: attrs.defaultChecked === true,
      });
    });
    forms.push({ action: props.action, fields });
  });
  return forms;
}

/**
 * What the browser posts for one form: every named control's value, and for a
 * checkbox the literal 'on' ONLY when it is ticked. An unchecked checkbox is
 * omitted from the submission entirely — which is the whole reason the brand
 * rule's `active` read had to become `=== 'on'`.
 */
function submissionFor(form: Form, edits: Record<string, string | boolean> = {}): FormData {
  const data = new FormData();
  for (const field of form.fields) {
    const edited = edits[field.name];
    if (field.checkbox) {
      const ticked = typeof edited === 'boolean' ? edited : field.checked;
      if (ticked) data.set(field.name, 'on');
      continue;
    }
    data.set(field.name, typeof edited === 'string' ? edited : field.value);
  }
  return data;
}

async function renderedForms(): Promise<Form[]> {
  return formsOf(await resolveTree(await MarketingPlatformPage()));
}

/** Every text node the page renders, trimmed — what an operator actually reads. */
async function renderedText(): Promise<string[]> {
  const texts: string[] = [];
  const collect = (node: ReactNode): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node).trim();
      if (text) texts.push(text);
      return;
    }
    if (Array.isArray(node)) { for (const child of node) collect(child); return; }
    if (!isValidElement(node)) return;
    const props = node.props as { children?: ReactNode };
    if (props?.children !== undefined) collect(props.children);
  };
  collect(await resolveTree(await MarketingPlatformPage()));
  return texts;
}

/** The form the page renders for one existing row, found by the id it posts. */
async function editorFor(action: unknown, rowId: string): Promise<Form> {
  const forms = await renderedForms();
  const found = forms.find((form) => form.action === action
    && form.fields.some((field) => field.name === 'id' && field.value === rowId));
  if (!found) {
    throw new Error(`no form on /admin/marketing/platform posts id=${rowId}; the row is not editable`);
  }
  return found;
}

// ── Fixture ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  marketing_generation_jobs: {
    job_type: 'regenerate_page', target_type: 'marketing_page', target_id: null, target_path: null,
    status: 'queued', priority: 50, attempts: 0, max_attempts: 5,
    run_after: new Date(0).toISOString(), locked_at: null, started_at: null, completed_at: null,
    payload: {}, result: {}, error: null, created_by: null,
  },
  marketing_pages: {
    page_type: 'feature', status: 'published', version: 1, summary: null, body: null,
    content: {}, seo: {}, aeo: {}, deleted_at: null, created_by: null, updated_by: null,
  },
  marketing_brand_rules: { instructions: '', value: {}, version: 1, active: true, updated_by: null },
  marketing_content_templates: {
    description: null, schema: {}, instructions: '', defaults: {}, version: 1,
    status: 'active', is_default: false, created_by: null, updated_by: null,
  },
};

function claimRegenerations(args: Record<string, unknown>, db: InMemorySupabase): Row[] {
  const limit = Math.max(1, Math.min(Number(args.p_limit ?? 10), 50));
  const now = Date.now();
  const due = db.table('marketing_generation_jobs')
    .filter((row) => row.status === 'queued' && row.job_type === 'regenerate_page'
      && new Date(String(row.run_after)).getTime() <= now)
    .slice(0, limit);
  const stamp = new Date().toISOString();
  for (const row of due) {
    row.status = 'running';
    row.attempts = Number(row.attempts) + 1;
    row.locked_at = stamp;
    row.started_at = stamp;
  }
  return due.map((row) => ({ ...row }));
}

function fresh(): InMemorySupabase {
  const fake = createInMemorySupabase({
    uniques: {
      marketing_generation_jobs: [['idempotency_key']],
      // 0237:81 — and service_role does not bypass it.
      marketing_brand_rules: [['rule_key']],
    },
    defaults: DEFAULTS,
    rpc: { claim_marketing_generation_jobs: claimRegenerations },
  });
  state.db = fake;
  fake.seed('marketing_pages', [{
    id: 'page-1', slug: 'meal-planning', path: '/features/meal-planning', title: 'Meal planning',
    summary: 'Plan the week from what your family already eats.', body: 'Source facts.',
  }]);
  fake.seed('marketing_brand_rules', [{
    id: 'rule-1', rule_key: 'brand_voice', name: 'Brand voice', instructions: WRONG,
    value: { examples: 'Warm, precise.' }, active: true,
  }]);
  fake.seed('marketing_content_templates', [{
    id: 'tpl-1', name: 'Guide template', page_type: 'feature', instructions: 'Open with the outcome.',
    defaults: { cta_label: 'Start free', section_count: 4 }, status: 'active', is_default: true,
  }]);
  return fake;
}

/** Queue one regeneration and run the worker; returns the prompt the model got. */
async function regenerate(fake: InMemorySupabase): Promise<string> {
  fake.seed('marketing_generation_jobs', [{
    job_type: 'regenerate_page', target_id: 'page-1', target_path: '/features/meal-planning',
    idempotency_key: `manual-${fake.table('marketing_generation_jobs').length}`, status: 'queued',
  }]);
  const before = state.prompts.length;
  const summary = await processMarketingGenerationJobs(fake as never);
  expect(summary.succeeded).toBe(1);
  expect(state.prompts).toHaveLength(before + 1);
  return state.prompts[before];
}

beforeEach(() => {
  state.audit.mockReset().mockResolvedValue(undefined);
  state.revalidatePath.mockReset();
  state.revalidateTag.mockReset();
  state.prompts.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a brand rule can be corrected after it is saved', () => {
  it('replaces the wrong instruction instead of refusing the correction', async () => {
    const fake = fresh();
    // The generator really is being told the wrong thing right now.
    expect(await regenerate(fake)).toContain(WRONG);

    const editor = await editorFor(saveMarketingBrandRule, 'rule-1');
    await saveMarketingBrandRule(submissionFor(editor, { instructions: CORRECTED }));

    // One rule, corrected — not a rejected save, and not a second rule_key whose
    // instructions contradict the first.
    const rules = fake.table('marketing_brand_rules');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'rule-1', rule_key: 'brand_voice', instructions: CORRECTED, active: true });

    // What the model is told when it next writes the public page.
    const prompt = await regenerate(fake);
    expect(prompt).toContain(CORRECTED);
    expect(prompt).not.toContain(WRONG);
  });

  it('keeps the rest of the rule when only one field is edited', async () => {
    const fake = fresh();
    const editor = await editorFor(saveMarketingBrandRule, 'rule-1');
    await saveMarketingBrandRule(submissionFor(editor, { name: 'Brand voice (2026)' }));

    expect(fake.table('marketing_brand_rules')).toHaveLength(1);
    expect(fake.table('marketing_brand_rules')[0]).toMatchObject({
      rule_key: 'brand_voice', name: 'Brand voice (2026)', instructions: WRONG, active: true,
    });
    expect(fake.table('marketing_brand_rules')[0].value).toMatchObject({ examples: 'Warm, precise.' });
  });

  it('lets an operator switch a rule off so it stops reaching the model', async () => {
    const fake = fresh();
    const editor = await editorFor(saveMarketingBrandRule, 'rule-1');
    await saveMarketingBrandRule(submissionFor(editor, { active: false }));

    expect(fake.table('marketing_brand_rules')[0]).toMatchObject({ active: false });
    expect(await regenerate(fake)).not.toContain(WRONG);
  });

  it('keeps what the rule stores beyond the one field the editor shows', async () => {
    const fake = fresh();
    // `value` is jsonb and the generator is fed all of it (JSON.stringify in
    // generateWithAI); the editor renders only `examples`.
    fake.table('marketing_brand_rules')[0].value = { examples: 'Warm, precise.', banned_phrases: ['revolutionary', 'game-changing'] };

    const editor = await editorFor(saveMarketingBrandRule, 'rule-1');
    await saveMarketingBrandRule(submissionFor(editor, { instructions: CORRECTED, examples: 'Plain, specific.' }));

    expect(fake.table('marketing_brand_rules')[0].value).toEqual({ examples: 'Plain, specific.', banned_phrases: ['revolutionary', 'game-changing'] });
    const prompt = await regenerate(fake);
    expect(prompt).toContain('game-changing');
    expect(prompt).toContain('Plain, specific.');
  });

  it('still creates an active rule from the card at the bottom', async () => {
    const fake = fresh();
    const forms = await renderedForms();
    const create = forms.find((form) => form.action === saveMarketingBrandRule
      && !form.fields.some((field) => field.name === 'id'));
    expect(create, 'the create form is still there').toBeTruthy();

    await saveMarketingBrandRule(submissionFor(create as Form, {
      rule_key: 'proof_policy', name: 'Proof policy', instructions: 'Cite only published research.',
    }));

    const added = fake.table('marketing_brand_rules').find((row) => row.rule_key === 'proof_policy');
    expect(added).toMatchObject({ active: true, instructions: 'Cite only published research.' });
    expect(await regenerate(fake)).toContain('Cite only published research.');
  });
});

describe('a template edit changes the template generation reads', () => {
  it('rewrites the existing row instead of leaving a duplicate beside it', async () => {
    const fake = fresh();
    expect(await regenerate(fake)).toContain('Open with the outcome.');

    const editor = await editorFor(saveMarketingTemplate, 'tpl-1');
    await saveMarketingTemplate(submissionFor(editor, { instructions: 'Open with the family outcome, then the mechanism.' }));

    // One "Guide template" in the list, so an operator can tell which row
    // generation reads — there is only one.
    const templates = fake.table('marketing_content_templates');
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      id: 'tpl-1', name: 'Guide template', is_default: true, status: 'active',
      instructions: 'Open with the family outcome, then the mechanism.',
    });

    const prompt = await regenerate(fake);
    expect(prompt).toContain('Open with the family outcome, then the mechanism.');
    expect(prompt).not.toContain('Open with the outcome.\n');
  });

  it('keeps the defaults the operator did not touch', async () => {
    const fake = fresh();
    const editor = await editorFor(saveMarketingTemplate, 'tpl-1');
    await saveMarketingTemplate(submissionFor(editor, { description: 'For feature pages.' }));

    const template = fake.table('marketing_content_templates')[0];
    expect(template).toMatchObject({ description: 'For feature pages.' });
    expect(template.defaults).toMatchObject({ cta_label: 'Start free', section_count: 4 });
    expect(await regenerate(fake)).toContain('Start free');
  });

  it('edits a draft template without putting it live or rewriting what the editor does not show', async () => {
    const fake = fresh();
    fake.seed('marketing_content_templates', [{
      id: 'tpl-2', name: 'Guide draft', page_type: 'guide', instructions: 'Lead with a checklist.', status: 'draft', is_default: false,
      schema: { fields: ['title', 'body'] }, defaults: { cta_label: 'Read the guide', section_count: 5, tone: 'warm' },
    }]);

    const editor = await editorFor(saveMarketingTemplate, 'tpl-2');
    await saveMarketingTemplate(submissionFor(editor, { instructions: 'Lead with a checklist, then the why.' }));

    const draft = fake.table('marketing_content_templates').find((row) => row.id === 'tpl-2');
    expect(draft).toMatchObject({ status: 'draft', instructions: 'Lead with a checklist, then the why.' });
    expect(draft?.schema).toEqual({ fields: ['title', 'body'] });
    expect(draft?.defaults).toEqual({ cta_label: 'Read the guide', section_count: 5, tone: 'warm' });
  });

  it('does not take away the template generation reads when "default" is ticked on a draft', async () => {
    const fake = fresh();
    fake.seed('marketing_content_templates', [{
      id: 'tpl-2', name: 'Feature draft', page_type: 'feature', instructions: 'Not ready for generation.', status: 'draft', is_default: false,
    }]);

    const editor = await editorFor(saveMarketingTemplate, 'tpl-2');
    await saveMarketingTemplate(submissionFor(editor, { is_default: true }));

    // The active default generation reads is still the active default.
    expect(fake.table('marketing_content_templates').find((row) => row.id === 'tpl-1')).toMatchObject({ status: 'active', is_default: true });
    const prompt = await regenerate(fake);
    expect(prompt).toContain('Open with the outcome.');
    expect(prompt).not.toContain('Not ready for generation.');
  });
});

describe('the editors speak English, not catalogue keys', () => {
  // RED until the orchestrator's catalogue merge lands: these five keys are asked
  // for in the i18n-asks file for this change and are not yet in
  // lib/i18n/messages/en-US.json. translate() renders a missing key as itself,
  // so without this case the page shipped "platform.saveChanges" on its buttons.
  it('labels every new control with its English copy', async () => {
    fresh();
    const texts = await renderedText();
    for (const copy of ['Save changes', 'Used for generation', 'Active — fed to every generation', 'Add a template', 'Add a brand rule']) {
      expect(texts, `the page should read "${copy}"`).toContain(copy);
    }
    expect(texts.filter((text) => /^[a-z][A-Za-z]*\.[a-z][A-Za-z.]*$/.test(text))).toEqual([]);
  });
});
