import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Actual VoiceModule, save/parse/router and installed React/Supabase execute.
// Speech, context, history subscription and presentation primitives are isolated;
// this exercises typed-command persistence, not a microphone or live provider.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sources = Object.fromEntries([
  'components/modules/voice-module.tsx', 'lib/capture/save.ts', 'lib/capture/parse.ts',
  'lib/voice/command-router.ts', 'lib/voice/transcript.ts', 'lib/supabase/errors.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(
  process.env.CAPTURE_VOICE_BASELINE === '1' && file === 'components/modules/voice-module.tsx'
    ? execFileSync('git', ['show', `608c9307:${file}`], { encoding: 'utf8' }) : fs.readFileSync(file, 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } },
).outputText]));
const catalogue = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const LIST = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const origin = 'https://voice-capture-fixture.invalid';
const provider = 'https://voice-capture.supabase.co';
type Probe = { mount: (family?: string) => void; unmount: () => void; run: () => Promise<void>; retained?: () => Promise<void>; inflight?: Promise<unknown>; undo?: () => Promise<void>; errors: string[]; toasts: string[]; throwClient: boolean };
declare global { interface Window { __voiceCapture: Probe } }

async function fixture(page: Page) {
  const state = {
    writes: [] as Array<{ table: string; method: string; body: Record<string, unknown> | null; query: string }>,
    items: [] as Array<Record<string, unknown>>, hold: '' as string, failed: false, empty: false, historyFailed: false,
    reads: [] as string[],
    release: async () => {},
  };
  const pending: Array<() => Promise<void>> = [];
  state.release = async () => { for (const finish of pending.splice(0)) await finish(); };
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' }));
  await page.route(`${provider}/rest/v1/**`, async route => {
    const request = route.request(), url = new URL(request.url()), table = url.pathname.split('/').pop()!;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === 'GET') state.reads.push(table);
    if (request.method() !== 'GET') state.writes.push({ table, method: request.method(), body: request.postData() ? request.postDataJSON() : null, query: url.search });
    const finish = async () => {
      if ((table === 'todo_items' && state.failed) || (table === 'voice_commands' && state.historyFailed)) {
        await route.fulfill({ status: 403, headers, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Fixture policy rejected write' }) }); return;
      }
      let rows: Record<string, unknown>[];
      if (request.method() === 'GET' && table === 'todo_lists') rows = [{ id: LIST }];
      else if (request.method() === 'POST') {
        const row = { id: ITEM, ...request.postDataJSON() as Record<string, unknown> };
        if (table === 'todo_items') state.items.push(row);
        rows = table === 'todo_items' && state.empty ? [] : [row];
      } else if (request.method() === 'DELETE' && table === 'todo_items') {
        rows = state.items.filter(row => url.searchParams.get('family_id') === `eq.${row.family_id}` && url.searchParams.get('id')?.includes(String(row.id)));
        state.items = state.items.filter(row => !rows.includes(row));
      } else throw new Error(`Unexpected fixture query ${request.method()} ${table}`);
      await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, headers, contentType: 'application/json', body: JSON.stringify(rows.map(row => ({ id: row.id }))) });
    };
    if (state.hold === table) pending.push(finish); else await finish();
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, catalogue = ${JSON.stringify(catalogue)};
    const p = window.__voiceCapture = { errors: [], toasts: [], throwClient: false };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => p.errors.push(String(event.reason)));
    const Context = React.createContext(null);
    const db = window.supabase.createClient(${JSON.stringify(provider)}, 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const tr = key => catalogue[key] || key;
    const mocks = {
      react: React, 'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/app/app-context': { useApp: () => React.useContext(Context) },
      '@/lib/hooks/use-speech-recognition': { useSpeechRecognition: () => ({ supported: false, listening: false, transcript: '', stop() {}, reset() {}, start() {} }) },
      '@/lib/hooks/use-realtime-query': { useRealtimeQuery: () => ({ data: [], loading: false, error: null, refresh() {} }) },
      '@/lib/supabase/client': { createClient: () => { if (p.throwClient) { p.throwClient = false; throw new Error('Fixture client construction failed'); } return db; } },
      '@/components/ui/toast': { useToast: () => ({ success: (message, action) => { p.toasts.push(message); if (action) p.undo = action.onClick; }, error: message => p.toasts.push(message) }) },
      '@/components/ui/button': { Button: props => { if (React.Children.toArray(props.children).includes(tr('voice.runCommand'))) p.run = props.onClick; const { variant, ...rest } = props; return React.createElement('button', rest); } },
      '@/components/ui/input': { Textarea: props => React.createElement('textarea', props) },
      '@/components/ui/states': { SkeletonList: () => null, ErrorState: () => null },
      '@/components/app/page-header': { PageHeader: () => null },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/lib/analytics/use-journey': { useJourney: () => ({ start() {}, complete() {}, abandon() {} }) },
      '@/components/i18n/locale-provider': { useTranslations: () => tr },
    };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (modules[id]) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected module ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const Voice = load('@/components/modules/voice-module').VoiceModule;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    p.mount = (familyId = ${JSON.stringify(FAMILY)}) => ReactDOM.flushSync(() => root.render(React.createElement(Context.Provider, { value: { familyId, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', selfMember: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } }, React.createElement(Voice))));
    p.unmount = () => ReactDOM.flushSync(() => root.render(null));
    p.mount();
  })();` });
  await page.getByRole('textbox').fill('Remind me to pack lunches');
  return state;
}

test.afterEach(async ({ page }) => { expect(await page.evaluate(() => window.__voiceCapture?.errors ?? [])).toEqual([]); });

test('confirmed capture and explicit earlier-family Undo use the checked original receipt', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: catalogue['voice.runCommand'], exact: true }).click();
  await expect.poll(() => state.items.length).toBe(1);
  await expect.poll(() => page.evaluate(() => typeof window.__voiceCapture.undo)).toBe('function');
  await page.evaluate(family => window.__voiceCapture.mount(family), OTHER_FAMILY);
  await page.evaluate(() => Promise.all([window.__voiceCapture.undo!(), window.__voiceCapture.undo!()]));
  expect(state.items).toHaveLength(0);
  expect(state.writes.filter(write => write.method === 'DELETE')).toHaveLength(1);
  expect(state.writes.find(write => write.method === 'DELETE')!.query).toContain(encodeURIComponent(FAMILY));
});

test('same-turn run callbacks dispatch one capture', async ({ page }) => {
  const state = await fixture(page); state.hold = 'todo_items';
  await page.evaluate(() => { void window.__voiceCapture.run(); void window.__voiceCapture.run(); });
  await expect.poll(() => state.writes.filter(write => write.table === 'todo_items').length).toBe(1);
  await state.release();
  await expect(page.getByRole('textbox')).toHaveValue('');
  expect(state.items).toHaveLength(1);
});

test('family switch retires held list lookup before capture and history mutations', async ({ page }) => {
  const state = await fixture(page); state.hold = 'todo_lists';
  await page.evaluate(() => { window.__voiceCapture.inflight = window.__voiceCapture.run(); });
  await expect.poll(() => state.reads).toContain('todo_lists');
  await page.evaluate(family => window.__voiceCapture.mount(family), OTHER_FAMILY);
  await state.release();
  await page.evaluate(() => window.__voiceCapture.inflight);
  expect(state.writes).toEqual([]);
  expect(await page.evaluate(() => window.__voiceCapture.toasts)).toEqual([]);
});

test('retained run after unmount makes no write', async ({ page }) => {
  const state = await fixture(page);
  await page.evaluate(() => { window.__voiceCapture.retained = window.__voiceCapture.run; window.__voiceCapture.unmount(); });
  await page.evaluate(() => window.__voiceCapture.retained!());
  expect(state.writes).toEqual([]);
});

test('ambiguous persisted capture blocks retry and never logs definitive failure', async ({ page }) => {
  expect(catalogue['quickCapture.saveUncertain']).toBeTruthy();
  expect(catalogue['quickCapture.reviewCapture']).toBeTruthy();
  const state = await fixture(page); state.empty = true;
  await page.evaluate(() => window.__voiceCapture.run());
  await expect(page.getByRole('link', { name: catalogue['quickCapture.reviewCapture'] })).toHaveAttribute('href', '/dashboard/todos');
  await expect(page.getByRole('textbox')).toBeDisabled();
  await page.evaluate(() => window.__voiceCapture.run());
  expect(state.items).toHaveLength(1);
  expect(state.writes.filter(write => write.table === 'voice_commands')).toEqual([]);
});

test('definitive rejected capture preserves the draft and permits deliberate retry', async ({ page }) => {
  const state = await fixture(page); state.failed = true;
  await page.evaluate(() => window.__voiceCapture.run());
  await expect(page.getByRole('textbox')).toHaveValue('Remind me to pack lunches');
  await expect(page.getByRole('textbox')).toBeEnabled();
  expect(state.items).toHaveLength(0);
  state.failed = false;
  await page.evaluate(() => window.__voiceCapture.run());
  expect(state.items).toHaveLength(1);
});

test('client construction failure is contained and releases the synchronous lock', async ({ page }) => {
  const state = await fixture(page);
  await page.evaluate(async () => { window.__voiceCapture.throwClient = true; await window.__voiceCapture.run(); });
  expect(state.writes).toEqual([]);
  await expect(page.getByRole('textbox')).toBeEnabled();
  await page.evaluate(() => window.__voiceCapture.run());
  expect(state.items).toHaveLength(1);
});

test('history rejection does not turn a confirmed capture into a failed repeatable command', async ({ page }) => {
  const state = await fixture(page); state.historyFailed = true;
  await page.evaluate(() => window.__voiceCapture.run());
  expect(state.items).toHaveLength(1);
  await expect(page.getByRole('textbox')).toHaveValue('');
  expect(await page.evaluate(() => typeof window.__voiceCapture.undo)).toBe('function');
});

test('a stalled best-effort history write does not hold confirmed capture feedback', async ({ page }) => {
  const state = await fixture(page); state.hold = 'voice_commands';
  await page.evaluate(() => { window.__voiceCapture.inflight = window.__voiceCapture.run(); });
  await expect.poll(() => state.writes.filter(write => write.table === 'voice_commands').length).toBe(1);
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(page.getByRole('textbox')).toBeEnabled();
  await state.release();
  await page.evaluate(() => window.__voiceCapture.inflight);
  expect(state.items).toHaveLength(1);
});
