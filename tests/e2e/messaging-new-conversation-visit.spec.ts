import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual MessagesModule/React/Supabase SDK; only synthetic transport, context and
// registered realtime delivery are controlled. No hosted Auth/RLS/provider proof.
const scripts = reactBrowserScripts('development');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sourceFiles = [
  'components/modules/messages-module.tsx', 'components/ui/toast.tsx', 'lib/hooks/use-media-query.ts',
  'components/ui/button.tsx', 'components/ui/input.tsx',
  'components/ui/modal.tsx', 'lib/a11y/use-dialog-behavior.ts',
  'components/ui/states.tsx', 'components/ui/states-client.tsx',
  'lib/messages/overview.ts', 'lib/messages/thread-state.ts', 'lib/messages/schema-compat.ts', 'lib/messages/reads.ts',
  'lib/messages/legacy-schema.ts', 'lib/messages/workspace-paths.ts', 'lib/supabase/escape-like.ts', 'lib/realtime/own-channel.ts',
  'lib/supabase/errors.ts', 'lib/supabase/settle.ts', 'lib/constants/roles.ts',
  'lib/utils/format.ts', 'lib/i18n/locales.ts',
];
const sources = Object.fromEntries(sourceFiles.map(file => [`@/${file.replace(/\.tsx?$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));
const ORIGIN = 'https://new-conversation-fixture.invalid';
const FAMILY = 'ca000000-0000-4000-8000-000000000001';
const SELF = 'cb000000-0000-4000-8000-000000000001';
const ONE = 'cb000000-0000-4000-8000-000000000002';
const TWO = 'cb000000-0000-4000-8000-000000000003';
const CHAT = 'cc000000-0000-4000-8000-000000000001';
const THREAD_B = 'cc000000-0000-4000-8000-000000000002';
const CREATED = 'cc000000-0000-4000-8000-000000000003';
const WHEN = '2026-10-23T12:00:00.000Z';
type Row = Record<string, unknown>;
type Call = { id: number; method: string; url: string; body: Row | null; consumed: boolean; delivered: boolean; headers: Record<string, string> };
declare global {
  interface Window {
    __newConversation: {
      errors: string[]; calls: Call[]; conversations: Row[]; held: { id: number; snapshot: Row; released: boolean } | null;
      release: () => void; reactVersion: string;
    };
  }
}
const browserErrors = new WeakMap<Page, string[]>();
async function start(page: Page, refused = false) {
  const errors: string[] = []; browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.type() + ': ' + msg.text()); });
  page.on('requestfailed', request => errors.push('Unexpected browser failure: ' + request.url()));
  await page.clock.install({ time: new Date(WHEN) });
  await page.route('**/*', route => {
    if (route.request().url() !== ORIGIN + '/') { errors.push('Unexpected browser network: ' + route.request().url()); return route.abort(); }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' });
  });
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: scripts.react });
  await page.addScriptTag({ content: scripts.reactDom });
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const p = window.__newConversation = { errors: [], calls: [], conversations: [], held: null, reactVersion: React.version };
    const clone = value => JSON.parse(JSON.stringify(value));
    const tr = key => key;
    const familyId = ${JSON.stringify(FAMILY)}, userId = ${JSON.stringify(SELF)};
    const people = [
      { id: 'cd000000-0000-4000-8000-000000000001', user_id: userId, display_name: 'Synthetic reader', role: 'parent' },
      { id: 'cd000000-0000-4000-8000-000000000002', user_id: ${JSON.stringify(ONE)}, display_name: 'Recipient One', role: 'adult' },
      { id: 'cd000000-0000-4000-8000-000000000003', user_id: ${JSON.stringify(TWO)}, display_name: 'Recipient Two', role: 'adult' },
    ].map(row => ({ ...row, family_id: familyId, is_active: true, color: '#336699' }));
    const scope = { familyId, userId, members: people, selfMember: people[0], role: 'parent' };
    function conversation(id, name, isFamily = false) {
      return { id, family_id: familyId, name, kind: 'group', avatar_emoji: null, description: null,
        is_archived: false, is_family_chat: isFamily, member_ids: people.map(row => row.user_id),
        participant_ids: people.map(row => row.id), created_by: userId, last_message_at: null,
        created_at: ${JSON.stringify(WHEN)}, updated_at: ${JSON.stringify(WHEN)} };
    }
    p.conversations.push(conversation(${JSON.stringify(CHAT)}, 'messagesModule.familyChat', true), conversation(${JSON.stringify(THREAD_B)}, 'Existing B'));
    let deliver;
    p.release = () => {
      if (!p.held || p.held.released || !deliver) throw new Error('No held creation ACK');
      p.held.released = true; deliver();
    };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    function assert(ok, reason) { if (!ok) { p.errors.push(reason); throw new Error(reason); } }
    function response(call, data, status = 200, count = null) {
      const snapshot = clone(data);
      const result = new Response(JSON.stringify(snapshot), { status, headers: { 'Content-Type': 'application/json',
        ...(count === null ? {} : { 'Content-Range': (snapshot.length ? '0-' + (snapshot.length - 1) : '*') + '/' + count }) } });
      for (const method of ['text', 'json']) {
        const native = result[method].bind(result);
        result[method] = async (...args) => { const value = await native(...args); call.consumed = true; return value; };
      }
      return result;
    }
    async function syntheticFetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url), headers = new Headers(init.headers);
      assert(url.origin === 'https://synthetic-new-conversation-db.invalid', 'Unexpected database origin');
      const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
      const call = { id: p.calls.length, method, url: url.href, body, headers: Object.fromEntries(headers.entries()), consumed: false, delivered: false };
      p.calls.push(call);
      const rpc = url.pathname.split('/rpc/')[1], params = url.searchParams;
      if (rpc) {
        assert(method === 'POST', 'RPC must use POST');
        if (rpc === 'create_family_conversation') {
          assert(!p.held && p.calls.filter(row => row.url.includes('/rpc/create_family_conversation')).length === 1, 'Duplicate create');
          assert(Object.keys(body).sort().join(',') === 'p_avatar_emoji,p_family_id,p_kind,p_name,p_participant_ids', 'Create RPC keys mismatch');
          assert(body.p_family_id === familyId && body.p_kind === 'group' && body.p_name === 'Committed old dialog'
            && body.p_avatar_emoji === '💬' && JSON.stringify(body.p_participant_ids) === JSON.stringify(people.map(row => row.id)), 'Create actor/audience/name envelope mismatch');
          if (${JSON.stringify(refused)}) { call.delivered = true; return response(call, { code: '42501', message: 'Synthetic create permission refused' }, 403); }
          const row = conversation(${JSON.stringify(CREATED)}, body.p_name);
          p.conversations.push(clone(row)); // Synthetic commit BEFORE immutable native ACK is held.
          const nativeResponse = response(call, row);
          p.held = { id: call.id, snapshot: clone(row), released: false };
          return new Promise(resolve => { deliver = () => { call.delivered = true; resolve(nativeResponse); }; });
        }
        assert(body && Object.keys(body).join(',') === 'p_family_id' && body.p_family_id === familyId, 'Unexpected family RPC envelope');
        if (rpc === 'ensure_family_conversation') { call.delivered = true; return response(call, ${JSON.stringify(CHAT)}); }
        if (rpc === 'family_conversation_overview') { call.delivered = true; return response(call, p.conversations.map(row => ({ conversation_id: row.id, last_message: null, unread_count: 0 })), 200, p.conversations.length); }
        assert(false, 'Unexpected RPC ' + rpc);
      }
      assert(method === 'GET', 'Unexpected table mutation ' + method);
      const table = url.pathname.split('/').pop();
      if (table === 'family_conversations') {
        assert(params.get('family_id') === 'eq.' + familyId && params.get('select')?.includes('is_family_chat'), 'Unscoped inbox');
        call.delivered = true; return response(call, p.conversations, 200, p.conversations.length);
      }
      const id = params.get('conversation_id')?.slice(3);
      assert(p.conversations.some(row => row.id === id), 'Unknown conversation read');
      if (table === 'family_conversation_preferences') {
        assert([...params.keys()].sort().join(',') === 'conversation_id,select,user_id' && params.get('select') === '*'
          && params.get('user_id') === 'eq.' + userId, 'Invalid current-user preference read');
        call.delivered = true; return response(call, []);
      }
      assert(table === 'family_messages' && params.get('select') === '*' && params.get('family_id') === 'eq.' + familyId
        && params.get('limit') === '51' && params.get('order') === 'created_at.desc,id.desc'
        && headers.get('prefer')?.includes('count=exact'), 'Unexpected empty window read');
      call.delivered = true; return response(call, [], 200, 0);
    }
    const real = window.supabase.createClient('https://synthetic-new-conversation-db.invalid', 'synthetic-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: syntheticFetch },
    });
    const client = { from: table => real.from(table), rpc: (name, args, options) => real.rpc(name, args, options),
      channel: () => { const ch = { on: () => ch, subscribe: () => ch, presenceState: () => ({}), track: async () => {}, send: async () => {} }; return ch; },
      removeChannel: async () => {},
    };
    const mocks = {
      react: React,
      'react-dom': ReactDOM,
      'lucide-react': Object.fromEntries([
        'MessageCircle', 'Plus', 'Send', 'Smile', 'Paperclip', 'Reply', 'Pin', 'Trash2',
        'MoreHorizontal', 'CheckCheck', 'ArrowLeft', 'Search', 'X', 'Camera', 'Loader2',
        'Check', 'Info', 'Settings', 'UserPlus', 'SlidersHorizontal', 'Mic', 'Image',
        'BellOff', 'Archive', 'ChevronRight', 'FileText', 'Download', 'CheckCircle2', 'AlertTriangle', 'Pencil', 'RefreshCw',
      ].map(name => [name, () => null])),
      'date-fns': { parseISO: value => new Date(value), format: value => new Date(value).toISOString(),
        isToday: value => value.toDateString() === new Date().toDateString(),
        isTomorrow: () => false },
      '@capacitor/core': { Capacitor: { isNativePlatform: () => false } },
      '@/components/app/app-context': { useApp: () => scope },
      '@/components/i18n/locale-provider': { useTranslations: () => tr, usePlural: () => (key) => tr(key), useLocale: () => ({ code: 'en-US' }) },
      '@/components/i18n/use-format': { useFormat: () => ({ fmtDate: value => value }),
        useFamilyClock: () => ({ dayKeyOf: value => value.slice(0, 10), todayKey: () => '2026-10-04',
          wallToday: () => new Date('2026-10-04T12:00:00Z'),
          addDays: (day, delta) => new Date(day.getTime() + delta * 86400000), wallKey: day => day.toISOString().slice(0, 10) }) },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/lib/supabase/client': { createClient: () => client },
      '@/lib/storage/family-media': { familyMediaPath: () => { throw new Error('Unexpected synthetic media write'); }, removeFamilyMedia: () => { throw new Error('Unexpected synthetic media removal'); } },
      '@/lib/storage/use-family-media': { useFamilyMediaUrls: () => () => undefined },
      '@/components/media/family-media-img': { FamilyMediaImg: () => { throw new Error('Unexpected synthetic attachment render'); } },
      '@/components/ai/ai-insight': { AiInsight: () => null },
      '@/components/messages/gif-picker': { GifPicker: () => { throw new Error('Unexpected synthetic GIF workflow'); } },
      '@/components/ui/avatar': { Avatar: props => React.createElement('span', null, props.name) },
    };


    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected new-conversation module: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(
        name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const Messages = load('@/components/modules/messages-module').MessagesModule;
    const ToastProvider = load('@/components/ui/toast').ToastProvider;
    ReactDOM.flushSync(() => ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(ToastProvider, null, React.createElement(Messages))));
  })();` });
  expect(await page.evaluate(() => window.__newConversation.reactVersion)).toMatch(/^19\./);
  await expect(page.getByRole('button').filter({ hasText: 'Existing B' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__newConversation.calls.some(call => call.consumed && new URL(call.url).pathname.endsWith('/family_messages')))).toBe(true);
  await clean(page);
}
async function clean(page: Page) {
  expect(browserErrors.get(page)).toEqual([]);
  expect(await page.evaluate(() => window.__newConversation.errors)).toEqual([]);
}
async function turn(page: Page) {
  await page.evaluate(async () => {
    const next = () => new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null); });
    await next(); await next();
    (window as unknown as { ReactDOM: { flushSync: (callback: () => void) => void } }).ReactDOM.flushSync(() => {});
  });
}
async function openDraft(page: Page, successor = false) {
  await page.getByRole('button', { name: 'messages.newMessage', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'messages.newConversation', exact: true });
  await expect(dialog).toBeVisible();
  if (!successor) await dialog.getByRole('button').filter({ hasText: 'Recipient One' }).click();
  await dialog.getByRole('button').filter({ hasText: 'Recipient Two' }).click();
  await dialog.getByRole('button', { name: /^messages.next/ }).click();
  await dialog.getByRole('textbox', { name: 'messagesChat.name', exact: true }).fill(successor ? 'Successor unsaved name' : 'Committed old dialog');
  return dialog;
}
async function commitAndHold(page: Page) {
  const dialog = await openDraft(page);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__newConversation.held !== null)).toBe(true);
  const held = await page.evaluate(() => window.__newConversation.held!);
  expect(held.released).toBe(false);
  expect(await page.evaluate(id => window.__newConversation.calls.find(call => call.id === id)?.consumed, held.id)).toBe(false);
  expect(await page.evaluate(() => window.__newConversation.conversations.filter(row => row.id === 'cc000000-0000-4000-8000-000000000003').length)).toBe(1);
  await clean(page);
  return held.id;
}
async function release(page: Page, id: number) {
  await page.evaluate(() => window.__newConversation.release());
  await expect.poll(() => page.evaluate(id => { const call = window.__newConversation.calls.find(row => row.id === id); return Boolean(call?.delivered && call.consumed); }, id)).toBe(true);
  await turn(page);
  await clean(page);
}
async function finalCommit(page: Page) {
  const state = await page.evaluate(() => ({ rows: window.__newConversation.conversations.filter(row => row.id === 'cc000000-0000-4000-8000-000000000003'), creates: window.__newConversation.calls.filter(call => call.url.includes('/rpc/create_family_conversation')), errors: window.__newConversation.errors }));
  expect(state.rows).toHaveLength(1); expect(state.rows[0].name).toBe('Committed old dialog');
  expect(state.creates).toHaveLength(1); expect(state.creates[0].consumed).toBe(true); expect(state.errors).toEqual([]);
}
test.afterEach(async ({ page }, info) => {
  if (!page.isClosed()) await info.attach('new-conversation-actual-state', { body: JSON.stringify(await page.evaluate(() => window.__newConversation ?? null), null, 2), contentType: 'application/json' });
});

test('a current dialog create commits once and opens its created conversation', async ({ page }) => {
  await start(page); const id = await commitAndHold(page);
  await release(page, id);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('p.text-brand-text').filter({ hasText: 'Committed old dialog' })).toBeVisible();
  await finalCommit(page); await clean(page);
});

test('a current explicit create refusal keeps its recipient and name draft retryable', async ({ page }) => {
  await start(page, true); const dialog = await openDraft(page);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__newConversation.calls.some(call => call.url.includes('/rpc/create_family_conversation') && call.consumed))).toBe(true);
  await turn(page); await clean(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'messagesChat.name', exact: true })).toHaveValue('Committed old dialog');
  await expect(dialog.getByText('Recipient One', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText('Recipient Two', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  await expect(page.getByText("You don't have permission to do that. Ask a family admin if you think this is a mistake.", { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic create permission refused', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => window.__newConversation.conversations.some(row => row.id === 'cc000000-0000-4000-8000-000000000003'))).toBe(false);
});

test('an old committed create ACK preserves a reopened dialog recipient and name draft', async ({ page }) => {
  await start(page); const id = await commitAndHold(page);
  await page.getByRole('dialog').getByRole('button', { name: 'modal.closeDialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const successor = await openDraft(page, true);
  await expect(successor.getByRole('textbox', { name: 'messagesChat.name', exact: true })).toHaveValue('Successor unsaved name');
  await expect(successor.getByText('Recipient Two', { exact: true }).first()).toBeVisible();
  await expect(successor.getByText('Recipient One', { exact: true })).toHaveCount(0);
  await release(page, id);
  await expect(successor).toBeVisible();
  await expect(successor.getByRole('textbox', { name: 'messagesChat.name', exact: true })).toHaveValue('Successor unsaved name');
  await expect(successor.getByText('Recipient Two', { exact: true }).first()).toBeVisible();
  await expect(successor.getByText('Recipient One', { exact: true })).toHaveCount(0);
  await finalCommit(page); await clean(page);
});

test('an old committed create ACK preserves a subsequently selected thread and its visible draft', async ({ page }) => {
  await start(page); const id = await commitAndHold(page);
  await page.getByRole('dialog').getByRole('button', { name: 'modal.closeDialog', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'Existing B' }).click();
  const composer = page.getByRole('textbox', { name: 'messages.typeAMessage', exact: true });
  await expect(page.locator('p.text-brand-text').filter({ hasText: 'Existing B' })).toBeVisible();
  await composer.fill('Unsent B draft'); await expect(composer).toHaveValue('Unsent B draft');
  await release(page, id);
  await expect(page.locator('p.text-brand-text').filter({ hasText: 'Existing B' })).toBeVisible();
  await expect(composer).toHaveValue('Unsent B draft');
  await finalCommit(page); await clean(page);
});
