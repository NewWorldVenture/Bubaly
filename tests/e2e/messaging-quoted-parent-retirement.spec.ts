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
const ORIGIN = 'https://quoted-parent-fixture.invalid';
const FAMILY_A = 'ba000000-0000-4000-8000-000000000001';
const FAMILY_B = 'ba000000-0000-4000-8000-000000000002';
const USER_A = 'bb000000-0000-4000-8000-000000000001';
const USER_B = 'bb000000-0000-4000-8000-000000000002';
const CHAT_A = 'bc000000-0000-4000-8000-000000000001';
const CHAT_B = 'bc000000-0000-4000-8000-000000000002';
const WHEN = '2026-10-23T12:00:00.000Z';
const OLD_BODY = 'Private parent A before deletion';
const REPLY_BODY = 'Unique reply A jump target';
const B_BODY = 'Authorized private parent B';
type Row = Record<string, unknown>;
type Read = { id: number; method: string; url: string; body: Row | null; headers: Record<string, string>; consumed: boolean; ids: string[]; total: number | null };
type Channel = { id: number; topic: string; removed: boolean };
declare global {
  interface Window {
    __quotedParent: {
      errors: string[]; calls: Read[]; channels: Channel[]; deliveries: Row[];
      reactVersion: string;
      heldParent: { callId: number; conversation: string; snapshot: Row[]; released: boolean } | null;
      releaseParentAck: () => void;
      retireParent: (channel: number, family: string, kind: 'UPDATE' | 'DELETE') => void;
      switchFamily: () => void;
      stored: Record<string, Row[]>;
    };
  }
}
const browserErrors = new WeakMap<Page, string[]>();
function rowId(family: string, index: number) {
  return (family === FAMILY_A ? 'bd000000' : 'be000000') + '-0000-4000-8000-' + String(index + 1).padStart(12, '0');
}
function dataset(family: string, historical: boolean): Row[] {
  const thread = family === FAMILY_A ? CHAT_A : CHAT_B;
  const length = historical ? 103 : 52;
  return Array.from({ length }, (_, index) => ({
    id: rowId(family, index), family_id: family, conversation_id: thread,
    content: index === 0 ? (family === FAMILY_A ? OLD_BODY : B_BODY)
      : index === 51 ? (family === FAMILY_A ? REPLY_BODY : 'Unique reply B') : 'Synthetic filler ' + family + ' ' + index,
    kind: 'text', sender_id: family === FAMILY_A ? USER_B : USER_A,
    sender_name: 'Synthetic sender', sender_avatar: null,
    attachment_url: null, attachment_name: null, attachment_mime: null,
    reply_to_id: index === 51 ? rowId(family, 0) : null, reactions: {},
    read_by: [USER_A, USER_B], is_pinned: false, deleted_at: null,
    created_at: new Date(Date.parse(WHEN) - (103 - index) * 60_000).toISOString(),
  }));
}
async function start(page: Page, historical: boolean, holdFirstParent = false) {
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
    const stored = ${JSON.stringify({ [CHAT_A]: dataset(FAMILY_A, historical), [CHAT_B]: dataset(FAMILY_B, false) })};
    const p = window.__quotedParent = { errors: [], calls: [], channels: [], deliveries: [], stored, reactVersion: React.version, heldParent: null };
    const holdFirstParent = ${JSON.stringify(holdFirstParent)};
    let releaseParent;
    p.releaseParentAck = () => {
      if (!p.heldParent || p.heldParent.released || !releaseParent) throw new Error('No unreleased initial parent ACK');
      p.heldParent.released = true; releaseParent();
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    const tr = key => key;
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const makeScope = (familyId, userId) => {
      const selfMember = { id: 'member-' + familyId + ':' + userId, family_id: familyId, user_id: userId, is_active: true, role: 'parent', display_name: 'Synthetic reader' };
      const other = { id: 'other-member-' + familyId, family_id: familyId, user_id: userId === ${JSON.stringify(USER_A)} ? ${JSON.stringify(USER_B)} : ${JSON.stringify(USER_A)}, is_active: true, role: 'adult', display_name: 'Synthetic sender' };
      return { familyId, userId, role: 'parent', members: [selfMember, other], selfMember };
    };
    let scope = makeScope(${JSON.stringify(FAMILY_A)}, ${JSON.stringify(USER_A)});
    const conversations = Object.fromEntries([
      [${JSON.stringify(FAMILY_A)}, ${JSON.stringify(CHAT_A)}], [${JSON.stringify(FAMILY_B)}, ${JSON.stringify(CHAT_B)}],
    ].map(([family, id]) => [family, [{ id, family_id: family, name: 'messagesModule.familyChat', kind: 'group', is_family_chat: true,
      avatar_emoji: null, description: null, is_archived: false, member_ids: [${JSON.stringify(USER_A)}, ${JSON.stringify(USER_B)}],
      participant_ids: [], created_by: family === ${JSON.stringify(FAMILY_A)} ? ${JSON.stringify(USER_A)} : ${JSON.stringify(USER_B)},
      last_message_at: null, created_at: ${JSON.stringify(WHEN)}, updated_at: ${JSON.stringify(WHEN)} }]]));
    function response(call, data, total = null) {
      const snapshot = clone(data); call.ids = Array.isArray(snapshot) ? snapshot.map(row => row.id || row.conversation_id) : [];
      call.total = total;
      const result = new Response(JSON.stringify(snapshot), { status: 200, headers: { 'Content-Type': 'application/json',
        ...(total === null ? {} : { 'Content-Range': (snapshot.length ? '0-' + (snapshot.length - 1) : '*') + '/' + total }) } });
      for (const method of ['text', 'json']) {
        const native = result[method].bind(result);
        result[method] = async (...args) => { const value = await native(...args); call.consumed = true; return value; };
      }
      return result;
    }
    function assert(ok, reason) { if (!ok) { p.errors.push(reason); throw new Error(reason); } }
    function pageRows(call, url, rows) {
      const total = rows.length;
      const order = (url.searchParams.get('order') || '').split(',');
      rows = [...rows].sort((a, b) => { for (const rule of order) {
        const [key, direction] = rule.split('.'); const n = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
        if (n) return direction === 'desc' ? -n : n;
      } return 0; });
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || rows.length);
      return response(call, rows.slice(offset, offset + limit), total);
    }
    async function syntheticFetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url), headers = new Headers(init.headers);
      assert(url.origin === 'https://synthetic-quoted-db.invalid', 'Unexpected synthetic database origin');
      const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
      const call = { id: p.calls.length, method, url: url.href, body, headers: Object.fromEntries(headers.entries()), consumed: false, ids: [], total: null };
      p.calls.push(call);
      const params = url.searchParams, family = params.get('family_id')?.slice(3) || body?.p_family_id;
      const rpc = url.pathname.split('/rpc/')[1];
      if (rpc) {
        assert(method === 'POST', 'Unexpected synthetic RPC method');
        if (rpc === 'mark_conversation_read_through') {
          assert(Object.keys(body || {}).sort().join(',') === 'p_conversation_id,p_message_id'
            && body.p_conversation_id === conversations[scope.familyId][0].id
            && stored[body.p_conversation_id].some(row => row.id === body.p_message_id), 'Unexpected read-through RPC envelope');
          return response(call, 0);
        }
        assert(family === scope.familyId, 'Unscoped synthetic family RPC');
        if (rpc === 'ensure_family_conversation') return response(call, conversations[family][0].id);
        if (rpc === 'family_conversation_overview') return pageRows(call, url, conversations[family].map(row => ({ conversation_id: row.id, last_message: null, unread_count: 0 })));
        assert(false, 'Unexpected synthetic RPC ' + rpc);
      }
      assert(method === 'GET', 'Unexpected app mutation ' + method + ' ' + url.pathname);
      const table = url.pathname.split('/').pop();
      if (table === 'family_conversations') {
        assert(params.get('family_id') === 'eq.' + scope.familyId, 'Inbox family mismatch');
        return pageRows(call, url, conversations[scope.familyId]);
      }
      if (table === 'family_conversation_preferences') {
        assert([...params.keys()].sort().join(',') === 'conversation_id,select,user_id' && params.get('select') === '*'
          && params.get('conversation_id') === 'eq.' + conversations[scope.familyId][0].id
          && params.get('user_id') === 'eq.' + scope.userId, 'Unexpected current-actor preferences query');
        return response(call, []);
      }
      assert(table === 'family_messages', 'Unexpected synthetic table ' + table);
      const thread = params.get('conversation_id')?.slice(3);
      assert(thread === conversations[scope.familyId][0].id, 'Message query crossed current synthetic conversation');
      let rows = stored[thread];
      const ids = params.get('id');
      if (ids) {
        const parent = stored[thread].find(row => row.reply_to_id)?.reply_to_id;
        assert([...params.keys()].sort().join(',') === 'conversation_id,id,select' && params.get('select') === '*'
          && ids === 'in.(' + parent + ')' && !headers.get('prefer')?.includes('count=exact'), 'Unexpected quoted-parent query shape');
        const selected = rows.filter(row => row.id === parent);
        if (holdFirstParent && thread === ${JSON.stringify(CHAT_A)} && !p.heldParent) {
          // Freeze the actual native response BEFORE holding its fetch ACK. The
          // SDK cannot consume it until release, even if stored rows change.
          const nativeResponse = response(call, selected);
          p.heldParent = { callId: call.id, conversation: thread, snapshot: clone(selected), released: false };
          return new Promise(resolve => { releaseParent = () => resolve(nativeResponse); });
        }
        return response(call, selected);
      }
      assert(params.get('family_id') === 'eq.' + scope.familyId && params.get('select') === '*', 'Window/search family scope missing');
      if (params.has('content')) {
        const target = thread === ${JSON.stringify(CHAT_A)} ? ${JSON.stringify(REPLY_BODY)} : 'Unique reply B';
        assert(params.get('content') === 'ilike.%' + target + '%' && params.get('deleted_at') === 'is.null'
          && params.get('limit') === '100' && params.get('order') === 'created_at.desc', 'Unexpected public search shape');
        return response(call, rows.filter(row => row.deleted_at === null && row.content === target));
      }
      assert(headers.get('prefer')?.includes('count=exact') && params.get('order') === 'created_at.desc,id.desc'
        && params.get('limit') === '51', 'Unexpected counted thread window shape');
      const cursor = params.get('or');
      if (cursor) {
        const target = stored[thread].find(row => row.reply_to_id);
        assert(cursor === '(created_at.lt.' + target.created_at + ',and(created_at.eq.' + target.created_at + ',id.lte.' + target.id + '))', 'Unexpected inclusive public jump cursor');
        rows = rows.filter(row => row.created_at < target.created_at || row.created_at === target.created_at && row.id <= target.id);
      }
      return pageRows(call, url, rows);
    }
    const real = window.supabase.createClient('https://synthetic-quoted-db.invalid', 'synthetic-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: syntheticFetch },
    });
    const client = {
      from: table => real.from(table), rpc: (name, args, options) => real.rpc(name, args, options),
      channel: topic => {
        const channel = { id: p.channels.length, topic, removed: false, bindings: [],
          on(kind, filter, callback) { this.bindings.push({ kind, filter, callback }); return this; },
          subscribe() { return this; }, presenceState() { return {}; }, track: async () => {}, send: async () => {} };
        p.channels.push(channel); return channel;
      }, removeChannel: async channel => { channel.removed = true; },
    };
    p.retireParent = (id, family, event) => {
      const thread = conversations[family][0].id, channel = p.channels.find(row => row.id === id);
      assert(channel?.topic.startsWith('msgs:' + thread + ':'), 'Wrong callback channel');
      const rows = stored[thread], parent = rows.find(row => row.id === rows.find(row => row.reply_to_id)?.reply_to_id);
      assert(Boolean(parent), 'Missing persisted synthetic parent');
      if (event === 'UPDATE') parent.deleted_at = ${JSON.stringify(WHEN)};
      else stored[thread] = rows.filter(row => row.id !== parent.id);
      const payload = { eventType: event, schema: 'public', table: 'family_messages', commit_timestamp: ${JSON.stringify(WHEN)},
        new: event === 'UPDATE' ? clone(parent) : {}, old: { id: parent.id } };
      const bindings = channel.bindings.filter(binding => binding.kind === 'postgres_changes' && binding.filter.schema === 'public'
        && binding.filter.table === 'family_messages' && binding.filter.event === event);
      assert(bindings.length === 1 && (event === 'DELETE' || bindings[0].filter.filter === 'conversation_id=eq.' + thread), 'Unexpected actual realtime binding');
      p.deliveries.push({ channel: id, removed: channel.removed, family, payload: clone(payload) });
      bindings[0].callback(clone(payload));
    };
    const mocks = {
      react: React,
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
      '@/components/ui/modal': { Modal: () => { throw new Error('Unexpected synthetic conversation form'); } },
      '@/components/ui/avatar': { Avatar: props => React.createElement('span', null, props.name) },
    };

    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected quoted-parent module: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(
        name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const Messages = load('@/components/modules/messages-module').MessagesModule;
    const ToastProvider = load('@/components/ui/toast').ToastProvider;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const render = () => ReactDOM.flushSync(() => root.render(React.createElement(ToastProvider, null, React.createElement(Messages))));
    p.switchFamily = () => { scope = makeScope(${JSON.stringify(FAMILY_B)}, ${JSON.stringify(USER_B)}); render(); };
    render();
  })();` });
  expect(await page.evaluate(() => window.__quotedParent.reactVersion)).toMatch(/^19\./);
}
async function browserTurn(page: Page) {
  await page.evaluate(async () => {
    const turn = () => new Promise<void>(resolve => { const ports = new MessageChannel();
      ports.port1.onmessage = () => { ports.port1.close(); ports.port2.close(); resolve(); }; ports.port2.postMessage(null); });
    await turn(); await turn();
    (window as unknown as { ReactDOM: { flushSync: (callback: () => void) => void } }).ReactDOM.flushSync(() => {});
  });
}
async function currentChannel(page: Page, thread = CHAT_A) {
  await expect.poll(() => page.evaluate(thread => window.__quotedParent.channels.filter(ch => ch.topic.startsWith('msgs:' + thread + ':') && !ch.removed).length, thread)).toBe(1);
  return page.evaluate(thread => window.__quotedParent.channels.find(ch => ch.topic.startsWith('msgs:' + thread + ':') && !ch.removed)!.id, thread);
}
async function parentRead(page: Page, thread: string, empty: boolean, after = -1) {
  await expect.poll(() => page.evaluate(({ thread, empty, after }) => window.__quotedParent.calls.some(call => call.id > after && call.consumed
    && new URL(call.url).searchParams.get('conversation_id') === 'eq.' + thread
    && new URL(call.url).searchParams.has('id') && (call.ids.length === 0) === empty), { thread, empty, after })).toBe(true);
  await browserTurn(page);
}
async function admit(page: Page, historical: boolean) {
  await start(page, historical);
  const channel = await currentChannel(page);
  if (historical) {
    await expect(page.locator('#message-' + rowId(FAMILY_A, 102))).toBeVisible();
    await expect(page.locator('#message-' + rowId(FAMILY_A, 51))).toHaveCount(0);
    await page.getByRole('textbox', { name: 'messagesChat.searchThread', exact: true }).fill(REPLY_BODY);
    await page.clock.runFor(300);
    const result = page.getByLabel('messagesChat.searchResults', { exact: true }).getByRole('button').filter({ hasText: REPLY_BODY });
    await expect(result).toBeVisible(); await result.click();
    await expect(page.getByRole('button', { name: 'messagesChat.latest', exact: true })).toBeVisible();
  } else await expect(page.getByRole('button', { name: 'messagesChat.latest', exact: true })).toHaveCount(0);
  const reply = page.locator('#message-' + rowId(FAMILY_A, 51));
  await expect(reply.getByText(REPLY_BODY, { exact: true })).toBeVisible();
  await parentRead(page, CHAT_A, false);
  await expect(reply.getByText(OLD_BODY, { exact: true })).toBeVisible();
  await expect(page.locator('#message-' + rowId(FAMILY_A, 0))).toHaveCount(0);
  const windows = await page.evaluate(() => window.__quotedParent.calls.filter(call => call.consumed && new URL(call.url).pathname.endsWith('/family_messages') && new URL(call.url).searchParams.has('limit') && !new URL(call.url).searchParams.has('content')));
  expect(windows[0].total).toBe(historical ? 103 : 52); expect(windows[0].ids).toHaveLength(51);
  if (historical) { expect(windows.at(-1)!.total).toBe(52); expect(windows.at(-1)!.ids).toHaveLength(51); }
  return channel;
}
async function retire(page: Page, channel: number, family: string, kind: 'UPDATE' | 'DELETE') {
  await page.evaluate(({ channel, family, kind }) => window.__quotedParent.retireParent(channel, family, kind), { channel, family, kind });
  await browserTurn(page);
}
async function assertStableHistory(page: Page) {
  await expect(page.getByRole('button', { name: 'messagesChat.latest', exact: true })).toBeVisible();
  await expect(page.locator('#message-' + rowId(FAMILY_A, 51)).getByText(REPLY_BODY, { exact: true })).toBeVisible();
  await expect(page.locator('#message-' + rowId(FAMILY_A, 0))).toHaveCount(0);
}
test.afterEach(async ({ page }, testInfo) => {
  const state = await page.evaluate(() => window.__quotedParent ? { calls: window.__quotedParent.calls,
    deliveries: window.__quotedParent.deliveries, channels: window.__quotedParent.channels,
    stored: window.__quotedParent.stored, errors: window.__quotedParent.errors, heldParent: window.__quotedParent.heldParent } : null);
  await testInfo.attach('synthetic-transport-and-persisted-state', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
  expect(browserErrors.get(page) ?? []).toEqual([]);
  expect(state?.errors ?? []).toEqual([]);
  expect(state?.calls.filter(call => call.method !== 'GET' && !new URL(call.url).pathname.includes('/rpc/')) ?? []).toEqual([]);
});

test('latest-view soft deletion retires an older quoted parent body', async ({ page }) => {
  const channel = await admit(page, false);
  await retire(page, channel, FAMILY_A, 'UPDATE');
  const reply = page.locator('#message-' + rowId(FAMILY_A, 51));
  expect(await reply.getByText(OLD_BODY, { exact: true }).count()).toBe(0);
  await expect(reply.getByText('messages.messageDeleted', { exact: true })).toBeVisible();
  await expect(reply.getByText(REPLY_BODY, { exact: true })).toBeVisible();
});

test('historical-view soft deletion retires its cached quoted parent body', async ({ page }) => {
  const channel = await admit(page, true);
  await retire(page, channel, FAMILY_A, 'UPDATE');
  // Absence is measured only after committed synthetic row/event and React turns.
  expect(await page.locator('#message-' + rowId(FAMILY_A, 51)).getByText(OLD_BODY, { exact: true }).count()).toBe(0);
  await assertStableHistory(page);
});

test('historical hard deletion clears the quote after its empty parent read ACK', async ({ page }) => {
  const channel = await admit(page, true);
  const before = await page.evaluate(() => window.__quotedParent.calls.length - 1);
  await retire(page, channel, FAMILY_A, 'DELETE');
  await parentRead(page, CHAT_A, true, before);
  expect(await page.locator('#message-' + rowId(FAMILY_A, 51)).getByText(OLD_BODY, { exact: true }).count()).toBe(0);
  await assertStableHistory(page);
});

test('a retired family callback preserves the current family private quote', async ({ page }) => {
  const channel = await admit(page, true);
  await page.evaluate(() => window.__quotedParent.switchFamily());
  await currentChannel(page, CHAT_B); await parentRead(page, CHAT_B, false);
  await expect(page.locator('#message-' + rowId(FAMILY_B, 51)).getByText(B_BODY, { exact: true })).toBeVisible();
  expect(await page.evaluate(id => window.__quotedParent.channels.find(ch => ch.id === id)?.removed, channel)).toBe(true);
  await retire(page, channel, FAMILY_A, 'UPDATE');
  expect(await page.getByText(OLD_BODY, { exact: true }).count()).toBe(0);
  await expect(page.locator('#message-' + rowId(FAMILY_B, 51)).getByText(B_BODY, { exact: true })).toBeVisible();
  await expect(page.locator('#message-' + rowId(FAMILY_B, 51)).getByText('Unique reply B', { exact: true })).toBeVisible();
  await expect(page.locator('#message-' + rowId(FAMILY_A, 51))).toHaveCount(0);
});

test('a held older parent ACK cannot restore a quote after its soft deletion event', async ({ page }) => {
  await start(page, true, true);
  const channel = await currentChannel(page);
  await expect(page.locator('#message-' + rowId(FAMILY_A, 102))).toBeVisible();
  await expect(page.locator('#message-' + rowId(FAMILY_A, 51))).toHaveCount(0);
  await page.getByRole('textbox', { name: 'messagesChat.searchThread', exact: true }).fill(REPLY_BODY);
  await page.clock.runFor(300);
  const result = page.getByLabel('messagesChat.searchResults', { exact: true }).getByRole('button').filter({ hasText: REPLY_BODY });
  await expect(result).toBeVisible(); await result.click();
  await expect.poll(() => page.evaluate(() => window.__quotedParent.heldParent !== null)).toBe(true);
  await assertStableHistory(page);
  const reply = page.locator('#message-' + rowId(FAMILY_A, 51));
  await expect(reply.getByText(OLD_BODY, { exact: true })).toHaveCount(0);
  const held = await page.evaluate(() => { const p = window.__quotedParent; return { ...p.heldParent!, consumed: p.calls[p.heldParent!.callId].consumed }; });
  expect(held.conversation).toBe(CHAT_A); expect(held.released).toBe(false); expect(held.consumed).toBe(false);
  expect(held.snapshot).toHaveLength(1); expect(held.snapshot[0].id).toBe(rowId(FAMILY_A, 0));
  expect(held.snapshot[0].content).toBe(OLD_BODY); expect(held.snapshot[0].deleted_at).toBeNull();
  const windows = await page.evaluate(() => window.__quotedParent.calls.filter(call => call.consumed && new URL(call.url).pathname.endsWith('/family_messages') && new URL(call.url).searchParams.has('limit') && !new URL(call.url).searchParams.has('content')));
  expect(windows[0].total).toBe(103); expect(windows[0].ids).toHaveLength(51);
  expect(windows.at(-1)!.total).toBe(52); expect(windows.at(-1)!.ids).toHaveLength(51);
  await retire(page, channel, FAMILY_A, 'UPDATE');
  // The old response and exposed snapshot stay immutable after commit/event.
  expect(await page.evaluate(() => window.__quotedParent.heldParent!.snapshot[0].deleted_at)).toBeNull();
  expect(await page.evaluate(thread => window.__quotedParent.stored[thread][0].deleted_at, CHAT_A)).toBe(WHEN);
  await page.evaluate(() => window.__quotedParent.releaseParentAck());
  await expect.poll(() => page.evaluate(id => window.__quotedParent.calls.find(call => call.id === id)?.consumed, held.callId)).toBe(true);
  await parentRead(page, CHAT_A, false, held.callId - 1);
  expect(await page.evaluate(() => window.__quotedParent.heldParent!.released)).toBe(true);
  await assertStableHistory(page);
  expect(await reply.getByText(OLD_BODY, { exact: true }).count()).toBe(0);
  await expect(reply.getByText('messages.messageDeleted', { exact: true })).toBeVisible();
});
