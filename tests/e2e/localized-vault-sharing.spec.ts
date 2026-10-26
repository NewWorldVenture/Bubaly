import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Real FilesHub, React, Modal, query hook and installed SDK. Only HTTP is synthetic.
// This proves the persisted write, never native child RLS or Storage authorization.
const origin = 'https://localized-vault.synthetic.invalid';
const family = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const documentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sourceRoot = process.cwd();
const { react, reactDom } = reactBrowserScripts();
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');
const messages = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'lib/i18n/messages/en-US.json'), 'utf8'));
const seams = new Set(['react', 'react-dom', 'lucide-react', 'next/link', 'next/navigation', '@/components/app/app-context', '@/components/i18n/locale-provider', '@/components/i18n/use-format', '@/components/ui/toast', '@/components/ai/ai-insight', '@/lib/supabase/client', '@/lib/offline/cache-scope']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, filename + '.ts', filename + '.tsx', path.join(filename, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile()) ?? filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? 'module.exports=' + raw : /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    item.imports[name] = seams.has(name) ? name : collect(name.startsWith('@/') ? path.join(sourceRoot, name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(id), name) : require.resolve(name, { paths: [path.dirname(id)] }));
  }
  return id;
}
const entry = collect(path.join(sourceRoot, 'components/modules/files-hub-module.tsx'));
type Row = Record<string, unknown> & { id: string; family_id: string; category: string; is_secure: boolean; storage_path: string };
type Operation = { method: string; pathname: string; query: Record<string, string>; body: unknown; committed: boolean; status: number };
type Mode = 'healthy' | 'refused' | 'zero';
const faults = new WeakMap<Page, string[]>();
// The header and empty state both expose Upload; select the real header action.
const uploadOpener = (page: Page) => page.getByRole('heading', { level: 1 }).locator('..').locator('..').getByRole('button', { name: 'Upload', exact: true });

test.beforeEach(async ({ page }) => {
  const errors: string[] = []; faults.set(page, errors);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  page.on('requestfailed', r => errors.push(r.url()));
});
test.afterEach(async ({ page }) => {
  expect(faults.get(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__vault?.errors ?? [])).toEqual([]);
});

async function mount(page: Page, category: string, uploadView: 'shared' | 'vault', mode: Mode) {
  const rows: Row[] = [], objects: string[] = [], operations: Operation[] = [];
  await page.route('**/*', async route => {
    expect(route.request().url(), 'no external network').toBe(origin + '/');
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' });
  });
  await page.exposeFunction('__vaultFetch', async (url: string, method: string, body: any) => {
    const parsed = new URL(url); expect(parsed.origin).toBe(origin);
    const op: Operation = { method, pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body, committed: false, status: 200 };
    operations.push(op);
    if (parsed.pathname.startsWith('/storage/v1/object/documents/') && method === 'POST') {
      const object = decodeURIComponent(parsed.pathname.slice('/storage/v1/object/documents/'.length));
      expect(object.startsWith(family + '/')).toBe(true);
      expect(body).toMatchObject({ fileName: 'synthetic-statement.pdf', fileSize: 26, contentType: 'application/pdf' });
      objects.push(object); op.committed = true;
      return { status: 200, body: { Key: 'documents/' + object, Id: documentId } };
    }
    expect(parsed.pathname).toBe('/rest/v1/documents');
    if (method === 'GET') {
      expect(parsed.searchParams.get('family_id')).toBe('eq.' + family);
      const offset = Number(parsed.searchParams.get('offset') ?? 0), limit = Number(parsed.searchParams.get('limit') ?? 1000);
      return { status: 200, body: structuredClone(rows.slice(offset, offset + limit)) };
    }
    if (method === 'POST') {
      expect(body).toMatchObject({ family_id: family, category, is_secure: true, created_by: user, title: 'Synthetic statement' });
      expect(objects).toEqual([body.storage_path]);
      rows.push({ ...body, id: documentId, created_at: '2026-10-23T12:00:00Z', is_favorite: false });
      op.committed = true; op.status = 201;
      return { status: 201, body: null };
    }
    if (method === 'PATCH') {
      expect(op.query).toMatchObject({ id: 'eq.' + documentId, family_id: 'eq.' + family, select: 'id' });
      expect(Object.keys(body)).toEqual(['is_secure']); expect(typeof body.is_secure).toBe('boolean');
      if (mode === 'refused') { op.status = 403; return { status: 403, body: { code: '42501', message: 'Synthetic refusal' } }; }
      if (mode === 'zero') return { status: 200, body: [] };
      Object.assign(rows[0], body); op.committed = true;
      return { status: 200, body: [{ id: documentId }] };
    }
    throw new Error('Unexpected synthetic operation ' + method + ' ' + parsed.pathname);
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk, 'window.react=window.React;', icons]) await page.addScriptTag({ content });
  await page.evaluate(({ sources, entry, messages, origin, family, user, uploadView }) => {
    const w = window as any, R = w.React, D = w.ReactDOM;
    const p: { errors: string[]; notices: any[]; consumedPatch: number; consumedInsert: number; modeTransitions: string[]; mountPublicMode?: (view: string) => void } = w.__vault = { errors: [] as string[], notices: [] as any[], consumedPatch: 0, consumedInsert: 0, modeTransitions: [] as string[] };
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const client = w.supabase.createClient(origin, 'synthetic-not-a-secret', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url: any, init: any) => {
      const method = init?.method ?? 'GET';
      let body: any = null;
      if (init?.body instanceof FormData) {
        const file = init.body.get('') ?? [...init.body.values()].find((v: any) => v instanceof File);
        body = { fileName: file?.name, fileSize: file?.size, contentType: file?.type };
      } else if (init?.body) body = JSON.parse(init.body);
      const reply = await w.__vaultFetch(String(url), method, body);
      // Count body consumption, not merely dispatch/transport acknowledgment.
      const response = new Response(reply.body === null ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
      if (method === 'PATCH' || (method === 'POST' && String(url).includes('/rest/v1/documents'))) {
        const original = response.text.bind(response);
        response.text = async () => { const text = await original(); method === 'PATCH' ? p.consumedPatch++ : p.consumedInsert++; return text; };
      }
      return response;
    } } });
    // SDK table/storage builders remain untouched. Realtime has no live server.
    const db = new Proxy(client, { get(target, property) {
      if (property === 'channel') return () => ({ on() { return this; }, subscribe() { return this; }, unsubscribe: async () => {} });
      if (property === 'removeChannel') return async () => {};
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const tr = (key: string, vars: Record<string, unknown> = {}) => Object.entries(vars).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), messages[key] ?? key);
    const fail = () => { throw new Error('Navigation/AI is outside synthetic FilesHub proof'); };
    const mocks: Record<string, any> = {
      react: R, 'react-dom': D, 'lucide-react': w.LucideReact,
      'next/link': { default: (props: any) => R.createElement('a', props, props.children) },
      'next/navigation': { useRouter: () => ({ push: fail, refresh: fail }) },
      '@/components/app/app-context': { useApp: () => ({ familyId: family, userId: user, role: 'parent', members: [] }) },
      '@/components/i18n/locale-provider': { useTranslations: () => tr, useLocale: () => ({ code: 'en-US' }), useFamilyTimeZone: () => 'UTC' },
      '@/components/i18n/use-format': { useFormat: () => ({ fmtDate: () => 'Oct 23, 2026' }) },
      '@/components/ui/toast': { useToast: () => ({ success: (message: string) => p.notices.push({ kind: 'success', message }), error: (message: string) => p.notices.push({ kind: 'error', message }) }) },
      '@/components/ai/ai-insight': { AiInsight: () => null }, '@/lib/supabase/client': { createClient: () => db },
      '@/lib/offline/cache-scope': { useAuthenticatedCacheScope: () => null, isAuthenticatedCacheScopeCurrent: () => true },
    };
    const loaded: Record<string, any> = {};
    function load(id: string): any {
      if (id in mocks) return mocks[id]; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Missing source ' + id);
      const loadedModule = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', item.source)((name: string) => load(item.imports[name]), loadedModule, loadedModule.exports); return loadedModule.exports;
    }
    const Component = load(entry).FilesHubModule;
    let root = D.createRoot(document.getElementById('root'));
    p.mountPublicMode = (view: string) => {
      // Controlled public route-input boundary, not a claim of full Next navigation.
      D.flushSync(() => root.unmount()); root = D.createRoot(document.getElementById('root'));
      p.modeTransitions.push(view); D.flushSync(() => root.render(R.createElement(Component, { view })));
    };
    root.render(R.createElement(Component, { view: uploadView }));
  }, { sources: modules, entry, messages, origin, family, user, uploadView });
  await expect(uploadOpener(page)).toBeVisible();
  return { rows, objects, operations };
}

const cases = [
  { label: 'English finances retain category protection while the vault flag may clear', category: 'Finances', view: 'vault', expectedSecure: false, mode: 'healthy', direction: 'out', protected: false },
  { label: 'an ordinary school file can move from vault to shared', category: 'School', view: 'vault', expectedSecure: false, mode: 'healthy', direction: 'out', protected: false },
  ...['Financiën', 'Versicherung', 'Gezondheid', 'Santé'].map(category => ({ label: category + ' stays secure with translated refusal and no PATCH', category, view: 'shared', expectedSecure: true, mode: 'healthy', direction: 'out', protected: true })),
  { label: 'a refused ordinary-folder PATCH retains the flag and reports failure', category: 'School', view: 'vault', expectedSecure: true, mode: 'refused', direction: 'out', protected: false },
  { label: 'a zero-row ordinary-folder PATCH retains the flag and reports failure', category: 'School', view: 'vault', expectedSecure: true, mode: 'zero', direction: 'out', protected: false },
  { label: 'a translated legacy shared row can still move INTO the Vault', category: 'Financiën', view: 'shared', expectedSecure: true, mode: 'healthy', direction: 'in', protected: false },
] as const;

for (const scenario of cases) test(scenario.label, async ({ page }, info) => {
  const proof = await mount(page, scenario.category, scenario.view as 'shared' | 'vault', scenario.mode as Mode);
  try {
    await uploadOpener(page).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'synthetic-statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic document content') });
    await dialog.getByLabel('Name', { exact: false }).fill('Synthetic statement');
    await dialog.getByLabel('Folder', { exact: true }).fill(scenario.category);
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__vault.consumedInsert)).toBe(1);
    expect(proof.rows).toHaveLength(1); expect(proof.objects).toEqual([proof.rows[0].storage_path]);
    expect(proof.rows[0]).toMatchObject({ family_id: family, category: scenario.category, is_secure: true });
    expect(await page.evaluate(() => (window as any).__vault.notices)).toEqual([{ kind: 'success', message: 'File uploaded' }]);
    if (scenario.direction === 'in') {
      // Explicit synthetic legacy-row boundary; no native historical/RLS claim.
      proof.rows[0].is_secure = false;
      await page.evaluate(() => (window as any).__vault.mountPublicMode('shared'));
    } else await page.evaluate(() => (window as any).__vault.mountPublicMode('vault'));
    await expect(page.getByText('Synthetic statement', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: scenario.direction === 'in' ? 'Move to vault' : 'Move to shared', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__vault.notices.length)).toBe(2);
    const patches = proof.operations.filter(op => op.method === 'PATCH');
    const notices = await page.evaluate(() => (window as any).__vault.notices);
    if (scenario.protected) {
      expect(patches).toHaveLength(0);
      expect(await page.evaluate(() => (window as any).__vault.consumedPatch)).toBe(0);
      expect(notices).toEqual([{ kind: 'success', message: 'File uploaded' }, { kind: 'error', message: String(messages['filesHubModule.sensitiveStaysInVault']).replace('{category}', scenario.category) }]);
      await expect(page.getByRole('button', { name: 'Move to shared', exact: true })).toBeVisible();
    } else {
      await expect.poll(() => page.evaluate(() => (window as any).__vault.consumedPatch)).toBe(1);
      expect(patches).toHaveLength(1);
      expect(patches[0].query).toMatchObject({ id: 'eq.' + documentId, family_id: 'eq.' + family, select: 'id' });
      if (scenario.mode === 'healthy') {
        expect(patches[0]).toMatchObject({ committed: true, status: 200 });
        expect(notices).toEqual([{ kind: 'success', message: 'File uploaded' }, { kind: 'success', message: scenario.direction === 'in' ? messages['filesHubModule.movedVault'] : messages['filesHubModule.movedShared'] }]);
      } else {
        expect(patches[0].committed).toBe(false); expect(notices.map((n: any) => n.kind)).toEqual(['success', 'error']);
        await expect(page.getByRole('button', { name: 'Move to shared', exact: true })).toBeVisible();
      }
    }
    expect(proof.rows[0].category).toBe(scenario.category);
    expect(proof.rows[0].is_secure).toBe(scenario.expectedSecure);
  } finally {
    await info.attach('synthetic-sdk-write-and-row-proof', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ scenario, operations: proof.operations, rows: proof.rows, objects: proof.objects, runtime: await page.evaluate(() => ({ consumedPatch: (window as any).__vault.consumedPatch, consumedInsert: (window as any).__vault.consumedInsert, notices: (window as any).__vault.notices, publicModeTransitions: (window as any).__vault.modeTransitions, errors: (window as any).__vault.errors })), browserErrors: faults.get(page) ?? [] }, null, 2)) });
  }
});
