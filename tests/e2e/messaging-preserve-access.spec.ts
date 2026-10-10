import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Real MessagesModule, React 19, toast/UI components and Supabase SDK. Only
// synthetic fetch results and realtime delivery are controlled. This fixture
// proves component lifecycle boundaries; PostgreSQL authorization has its own
// real-role fixture. No application server, hosted Auth or media provider runs.
const scripts = reactBrowserScripts('development');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sourceFiles = [
  'components/modules/messages-module.tsx', 'components/ui/toast.tsx', 'lib/hooks/use-media-query.ts',
  'components/ui/button.tsx', 'components/ui/input.tsx',
  'components/ui/states.tsx', 'components/ui/states-client.tsx',
  'lib/messages/overview.ts', 'lib/messages/thread-state.ts', 'lib/messages/schema-compat.ts', 'lib/messages/reads.ts',
  'lib/messages/legacy-schema.ts', 'lib/supabase/escape-like.ts', 'lib/realtime/own-channel.ts',
  'lib/supabase/errors.ts', 'lib/supabase/settle.ts', 'lib/constants/roles.ts',
  'lib/utils/format.ts', 'lib/i18n/locales.ts',
];
const sources = Object.fromEntries(sourceFiles.map(file => [`@/${file.replace(/\.tsx?$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));
const browserErrors = new WeakMap<Page, string[]>();
const expectedDiagnostics = new WeakMap<Page, string[]>();
const ORIGIN = 'https://messaging-preserve-access-fixture.invalid';
const FAMILY_A = 'aa000000-0000-4000-8000-000000000001';
const FAMILY_B = 'aa000000-0000-4000-8000-000000000002';
const USER_A = 'ab000000-0000-4000-8000-000000000001';
const USER_B = 'ab000000-0000-4000-8000-000000000002';
const OLD = 'ad000000-0000-4000-8000-000000000001';
const CHAT_A = 'ad000000-0000-4000-8000-000000000002';
const CHAT_B = 'ad000000-0000-4000-8000-000000000003';
const WHEN = '2026-10-04T12:00:00.000Z';

type Row = Record<string, unknown>;
type Reply = { data: unknown; count?: number; error: { code: string; message: string } | null };
type Config = {
  conversations: Record<string, Row[]>;
  messages?: Record<string, Row[]>;
  canonical?: Record<string, Row>;
  ensureError?: { code: string; message: string };
  readError?: { code: string; message: string };
  deferThread?: boolean;
  deferEnsure?: boolean;
  deferSend?: boolean;
  rejectSend?: boolean;
  media?: boolean;
  serverCap?: number;
  failMessageOffset?: number;
  failInboxOffset?: number;
};
type Call = { method: string; url: string; body: Row | null; family: string | null; conversation: string | null; user: string };
declare global {
  interface Window {
    __messagingPreserve: {
      errors: string[]; reactVersion: string; calls: Call[];
      mediaWrites: number;
      channels: { id: number; topic: string; removed: boolean }[];
      pending: { id: number; kind: string; family: string | null; conversation: string | null }[];
      configure: (changes: Partial<Config>) => void;
      switchScope: (familyId: string, userId: string) => void;
      resolvePending: (kind: string, family: string, reply: Reply) => void;
      resolvePendingAt: (id: number, reply: Reply) => void;
      rejectPendingAt: (id: number, reason: string) => void;
      emit: (id: number, event: string, newRow: Row, oldRow?: Row) => void;
      media: {
        requests: { id: number; tracksStopped: number; resolved: boolean }[];
        recorders: { id: number; streamId: number; state: string; stopCalls: number }[];
      };
      resolveMedia: (id: number) => void;
      fireRecorderData: (id: number) => void;
      fireRecorderStop: (id: number) => void;
      unmount: () => void;
    };
  }
}
const conversation = (id: string, family: string, name: string, canonical = false): Row => ({
  id, family_id: family, name: canonical ? 'messagesModule.familyChat' : name, kind: 'group', is_family_chat: canonical,
  avatar_emoji: '💬', description: null, is_archived: false,
  member_ids: [USER_A, USER_B], participant_ids: ['synthetic-member-a', 'synthetic-member-b'],
  created_by: USER_A, last_message_at: null, created_at: WHEN, updated_at: WHEN,
});
const message = (id: string, family: string, thread: string, content: string): Row => ({
  id, family_id: family, conversation_id: thread, content, kind: 'text',
  sender_id: USER_B, sender_name: 'Synthetic sender', sender_avatar: null,
  attachment_url: null, attachment_name: null, attachment_mime: null, reply_to_id: null,
  reactions: {}, read_by: [USER_A, USER_B], is_pinned: false, deleted_at: null, created_at: WHEN,
});

async function start(page: Page, config: Config) {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.type() + ': ' + msg.text());
  });
  page.on('requestfailed', request => errors.push('Failed browser request: ' + request.url()));
  await page.clock.install({ time: new Date(WHEN) });
  await page.route('**/*', route => {
    if (route.request().url() !== ORIGIN + '/') {
      errors.push('Unexpected browser request: ' + route.request().url());
      return route.abort();
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' });
  });
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: scripts.react });
  await page.addScriptTag({ content: scripts.reactDom });
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const config = ${JSON.stringify(config)};
    const p = window.__messagingPreserve = { errors: [], calls: [], channels: [], pending: [], mediaWrites: 0, reactVersion: React.version };
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    let scope = { familyId: ${JSON.stringify(FAMILY_A)}, userId: ${JSON.stringify(USER_A)},
      members: [], selfMember: { display_name: 'Synthetic self' } };
    const tr = key => key;
    const clone = value => JSON.parse(JSON.stringify(value));
    const respond = reply => new Response(JSON.stringify(reply.error || reply.data), {
      status: reply.error ? (reply.error.code === '42501' ? 403 : 400) : 200,
      headers: { 'Content-Type': 'application/json', ...(Array.isArray(reply.data) ? { 'Content-Range': '0-' + Math.max(0, reply.data.length - 1) + '/' + (reply.count ?? reply.data.length) } : {}) },
    });
    const pendingResolvers = new Map();
    p.media = { requests: [], recorders: [] };
    if (config.media) {
      const mediaResolvers = new Map();
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: constraints => {
          if (!constraints.audio) throw new Error('Unexpected synthetic media request');
          const request = { id: p.media.requests.length, tracksStopped: 0, resolved: false };
          p.media.requests.push(request);
          const stream = { id: request.id, getTracks: () => [{ stop: () => { request.tracksStopped++; } }] };
          return new Promise(resolve => mediaResolvers.set(request.id, { resolve, stream }));
        },
      } });
      window.MediaRecorder = class {
        constructor(stream) {
          this.id = p.media.recorders.length; this.streamId = stream.id; this.state = 'inactive';
          this.mimeType = 'audio/webm'; this.stopCalls = 0;
          p.media.recorders.push(this);
        }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; this.stopCalls++; }
      };
      p.resolveMedia = id => {
        const pending = mediaResolvers.get(id);
        if (!pending) throw new Error('Unknown synthetic media permission ' + id);
        mediaResolvers.delete(id); p.media.requests[id].resolved = true; pending.resolve(pending.stream);
      };
      p.fireRecorderData = id => {
        const recorder = p.media.recorders[id];
        if (!recorder) throw new Error('Unknown synthetic recorder ' + id);
        recorder.ondataavailable?.({ data: new Blob(['synthetic voice'], { type: 'audio/webm' }) });
      };
      p.fireRecorderStop = id => {
        const recorder = p.media.recorders[id];
        if (!recorder) throw new Error('Unknown synthetic recorder ' + id);
        void recorder.onstop?.();
      };
    }
    function hold(kind, family, conversation) {
      const id = p.pending.length;
      p.pending.push({ id, kind, family, conversation });
      return new Promise((resolve, reject) => pendingResolvers.set(id, { resolve, reject }));
    }
    p.configure = changes => Object.assign(config, changes);
    p.resolvePending = (kind, family, reply) => {
      for (const pending of p.pending) {
        const resolver = pendingResolvers.get(pending.id);
        if (pending.kind === kind && pending.family === family && resolver) {
          pendingResolvers.delete(pending.id); resolver.resolve(respond(reply));
        }
      }
    };
    p.resolvePendingAt = (id, reply) => {
      const resolver = pendingResolvers.get(id);
      if (!resolver) throw new Error('Unknown synthetic pending response ' + id);
      pendingResolvers.delete(id); resolver.resolve(respond(reply));
    };
    p.rejectPendingAt = (id, reason) => {
      const resolver = pendingResolvers.get(id);
      if (!resolver) throw new Error('Unknown synthetic pending response ' + id);
      pendingResolvers.delete(id); resolver.reject(new TypeError(reason));
    };
    function paged(rows, url) {
      const order = (url.searchParams.get('order') || '').split(',').filter(Boolean);
      rows = [...rows].sort((a, b) => { for (const rule of order) {
        const [key, direction, nulls] = rule.split('.');
        if (a[key] == null || b[key] == null) { if (a[key] == null && b[key] == null) continue; return a[key] == null ? (nulls === 'nullslast' ? 1 : -1) : (nulls === 'nullslast' ? -1 : 1); }
        const n = String(a[key]).localeCompare(String(b[key])); if (n) return direction === 'desc' ? -n : n;
      } return 0; });
      const count = rows.length, offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || count);
      return respond({ data: clone(rows.slice(offset, offset + Math.min(limit, config.serverCap ?? limit))), count, error: null });
    }
    async function syntheticFetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.origin !== 'https://synthetic-messages-db.invalid') throw new Error('Unexpected synthetic messaging fetch: ' + url);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      const family = url.searchParams.get('family_id')?.replace(/^eq\./, '') || body?.p_family_id || null;
      const thread = url.searchParams.get('conversation_id')?.replace(/^eq\./, '') || body?.conversation_id || body?.p_conversation_id || null;
      p.calls.push({ method, url: url.href, body, family, conversation: thread, user: scope.userId });
      const rpc = url.pathname.split('/rpc/')[1];
      if (rpc === 'ensure_family_conversation') {
        if (config.deferEnsure) return hold('ensure', family, null);
        if (config.ensureError) return respond({ data: null, error: config.ensureError });
        const saved = (config.conversations[family] || []).find(row => row.is_family_chat);
        const canonical = saved || config.canonical?.[family];
        if (!canonical) throw new Error('No synthetic canonical response for family ' + family);
        if (!saved) config.conversations[family] = [...(config.conversations[family] || []), clone(canonical)];
        return respond({ data: canonical.id, error: null });
      }
      if (rpc === 'mark_conversation_read_through') return respond({ data: 0, error: config.readError || null });
      if (rpc === 'family_conversation_overview') return paged((config.conversations[family] || []).map(row => ({ conversation_id: row.id, last_message: null, unread_count: 0 })), url);
      if (rpc) throw new Error('Unexpected synthetic messaging RPC: ' + rpc);
      const table = url.pathname.split('/').pop();
      if (table === 'family_conversations' && method === 'GET') {
        if (config.failInboxOffset !== undefined && Number(url.searchParams.get('offset') || 0) >= config.failInboxOffset) return respond({ data: null, error: { code: '42501', message: 'Synthetic later inbox page denied' } });
        return paged(config.conversations[family] || [], url);
      }
      if (table === 'family_conversation_preferences' && method === 'GET') return respond({ data: null, error: null });
      if (table === 'family_messages' && method === 'GET') {
        if (!thread) return respond({ data: [], error: null });
        if (config.deferThread) return hold('thread', family, thread);
        if (config.failMessageOffset !== undefined && Number(url.searchParams.get('offset') || 0) >= config.failMessageOffset) return respond({ data: null, error: { code: '42501', message: 'Synthetic later history page denied' } });
        let rows = (config.messages?.[thread] || []).filter(row => !family || row.family_id === family);
        if (url.searchParams.get('deleted_at') === 'is.null') rows = rows.filter(row => row.deleted_at == null);
        if (url.searchParams.get('is_pinned') === 'eq.true') rows = rows.filter(row => row.is_pinned);
        if (url.searchParams.get('kind') === 'eq.image') rows = rows.filter(row => row.kind === 'image');
        const cursor = url.searchParams.get('or');
        if (cursor) { const time = cursor.match(/created_at[.]lt[.]([^,]+)/)?.[1], id = cursor.match(/id[.](lt|lte)[.]([^)]*)/); rows = rows.filter(row => row.created_at < time || row.created_at === time && id && (id[1] === 'lte' ? row.id <= id[2] : row.id < id[2])); }
        return paged(rows, url);
      }
      if (table === 'family_messages' && method === 'POST' && config.deferSend) return hold('send', family, thread);
      // Read-receipt fallback is observable, but no unplanned conversation or
      // message insertion can accidentally appear as a successful fixture write.
      if (table === 'family_messages' && method === 'PATCH') return respond({ data: [{ id: url.searchParams.get('id')?.replace(/^eq\./, '') }], error: null });
      throw new Error('Unexpected synthetic messaging write: ' + method + ' ' + table);
    }
    const real = window.supabase.createClient('https://synthetic-messages-db.invalid', 'synthetic-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: syntheticFetch },
    });
    const client = {
      from: table => {
        const builder = real.from(table);
        if (table === 'family_messages' && config.rejectSend) {
          // The real SDK normally returns fetch failures as error results.
          // Its explicit throwing mode exercises the component's catch path.
          const insert = builder.insert.bind(builder);
          builder.insert = (...args) => insert(...args).throwOnError();
        }
        return builder;
      }, rpc: (name, args, options) => real.rpc(name, args, options),
      channel: topic => {
        const ch = { id: p.channels.length, topic, removed: false, bindings: [],
          on(kind, filter, callback) { this.bindings.push({ kind, filter, callback }); return this; },
          subscribe() { return this; }, presenceState() { return {}; }, track: async () => {}, send: async () => {},
        };
        p.channels.push(ch); return ch;
      },
      removeChannel: async ch => { ch.removed = true; },
    };
    p.emit = (id, event, newRow, oldRow = {}) => {
      const ch = p.channels.find(channel => channel.id === id);
      if (!ch) throw new Error('Unknown synthetic channel ' + id);
      // Deliberately call removed channels too: this is a callback already
      // queued before unsubscribe completed, so component guards must reject it.
      for (const binding of ch.bindings) if (binding.kind === 'postgres_changes' && (binding.filter.event === event || binding.filter.event === '*')) {
        binding.callback({ eventType: event, new: clone(newRow), old: clone(oldRow) });
      }
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
      '@/lib/storage/family-media': { familyMediaPath: () => { p.mediaWrites++; throw new Error('Unexpected synthetic media write'); }, removeFamilyMedia: () => { p.mediaWrites++; throw new Error('Unexpected synthetic media removal'); } },
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
      if (!(id in sources)) throw new Error('Unexpected messaging fixture module: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(
        name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const Messages = load('@/components/modules/messages-module').MessagesModule;
    const ToastProvider = load('@/components/ui/toast').ToastProvider;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const render = () => ReactDOM.flushSync(() => root.render(React.createElement(ToastProvider, null, React.createElement(Messages))));
    p.switchScope = (familyId, userId) => { scope = { ...scope, familyId, userId }; render(); };
    p.unmount = () => ReactDOM.flushSync(() => root.unmount());
    render();
  })();` });
  expect(await page.evaluate(() => window.__messagingPreserve.reactVersion)).toMatch(/^19\./);
}
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual(expectedDiagnostics.get(page) ?? []);
  expect(await page.evaluate(() => window.__messagingPreserve?.errors ?? [])).toEqual([]);
  expect(await page.evaluate(() => window.__messagingPreserve?.mediaWrites ?? 0)).toBe(0);
});
const base = (): Config => ({ conversations: { [FAMILY_A]: [conversation(CHAT_A, FAMILY_A, 'Canonical A', true)],
  [FAMILY_B]: [conversation(CHAT_B, FAMILY_B, 'Canonical B', true)] } });
async function liveMessageChannel(page: Page, thread: string): Promise<number> {
  await expect.poll(() => page.evaluate(id => window.__messagingPreserve.channels
    .filter(ch => ch.topic.startsWith('msgs:' + id + ':') && !ch.removed).length, thread)).toBe(1);
  return page.evaluate(id => window.__messagingPreserve.channels.find(ch => ch.topic.startsWith('msgs:' + id + ':') && !ch.removed)!.id, thread);
}
async function flushBrowser(page: Page) {
  // Let the resolved SDK response and React's scheduled commit both finish
  // before making an absence assertion against deliberately late deliveries.
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

for (const code of ['PGRST202', '42501']) {
  test('canonical RPC ' + code + ' is visible and never adopts or recreates a legacy group', async ({ page }) => {
    await start(page, { conversations: { [FAMILY_A]: [conversation(OLD, FAMILY_A, 'Old private group')] },
      ensureError: { code, message: 'Synthetic provider details must not appear' } });
    await expect(page.getByRole('alert')).toContainText(code === '42501' ? "You don't have permission" : 'messagesModule.couldNotCreateConversation');
    await expect(page.getByText('Synthetic provider details must not appear')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Old private group/ })).toHaveCount(1);
    const calls = await page.evaluate(() => window.__messagingPreserve.calls);
    expect(calls.filter(call => call.url.includes('/rpc/ensure_family_conversation'))).toHaveLength(1);
    expect(calls.some(call => call.method !== 'GET' && call.url.includes('/family_conversations'))).toBe(false);
  });
}

test('a legacy same-family group survives while the canonical RPC creates a separate empty chat', async ({ page }) => {
  const legacy = conversation(OLD, FAMILY_A, 'Old private group');
  await start(page, { conversations: { [FAMILY_A]: [legacy] },
    messages: { [OLD]: [message('legacy-history', FAMILY_A, OLD, 'Preserved old private history')] },
    canonical: { [FAMILY_A]: conversation(CHAT_A, FAMILY_A, 'New empty Family Chat', true) } });
  await expect(page.getByRole('button', { name: /Old private group/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /messagesModule.familyChat/ })).toHaveCount(1);
  await page.getByRole('button', { name: /Old private group/ }).click();
  await expect(page.getByText('Preserved old private history', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /messagesModule.familyChat/ }).click();
  await expect(page.getByText('messages.noMessagesYet', { exact: true })).toBeVisible();
  await expect(page.getByText('Preserved old private history', { exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => window.__messagingPreserve.calls);
  expect(calls.filter(call => call.url.includes('/rpc/ensure_family_conversation')).map(call => call.body)).toEqual([{ p_family_id: FAMILY_A }]);
  expect(calls.some(call => call.method !== 'GET' && call.url.includes('/family_conversations'))).toBe(false);
});

for (const switched of ['family', 'user'] as const) {
  test('an old thread load resolved after a ' + switched + ' switch cannot repaint or mark that old thread read', async ({ page }) => {
    await start(page, { ...base(), deferThread: true });
    await expect.poll(() => page.evaluate(() => window.__messagingPreserve.pending.filter(p => p.kind === 'thread').length)).toBeGreaterThan(0);
    const family = switched === 'family' ? FAMILY_B : FAMILY_A;
    const thread = switched === 'family' ? CHAT_B : CHAT_A;
    await page.evaluate(({ family, thread, user, row }) => {
      window.__messagingPreserve.configure({ deferThread: false, messages: { [thread]: [row] } });
      window.__messagingPreserve.switchScope(family, user);
    }, { family, thread, user: USER_B, row: message('current-load', family, thread, 'Current scope history') });
    await expect(page.getByText('Current scope history', { exact: true })).toBeVisible();
    const readCalls = await page.evaluate(() => window.__messagingPreserve.calls.filter(c => c.url.includes('/rpc/mark_conversation_read')).length);
    await page.evaluate(({ family, row }) => window.__messagingPreserve.resolvePending('thread', family, { data: [row], error: null }),
      { family: FAMILY_A, row: message('stale-load', FAMILY_A, CHAT_A, 'Stale old scope history') });
    await flushBrowser(page);
    await expect(page.getByText('Stale old scope history', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Current scope history', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__messagingPreserve.calls.filter(c => c.url.includes('/rpc/mark_conversation_read')).length)).toBe(readCalls);
  });
}

for (const late of ['success', 'failure'] as const) {
  test('a late canonical RPC ' + late + ' after family switching cannot reload or alert the new family', async ({ page }) => {
    await start(page, { ...base(), deferEnsure: true });
    await expect.poll(() => page.evaluate(() => window.__messagingPreserve.pending.filter(p => p.kind === 'ensure').length)).toBe(1);
    await page.evaluate(({ family, user }) => {
      window.__messagingPreserve.configure({ deferEnsure: false });
      window.__messagingPreserve.switchScope(family, user);
    }, { family: FAMILY_B, user: USER_B });
    await expect(page.getByRole('button', { name: /messagesModule.familyChat/ })).toHaveCount(1);
    await liveMessageChannel(page, CHAT_B);
    const before = await page.evaluate(family => window.__messagingPreserve.calls.filter(c => c.family === family && c.url.includes('/family_conversations')).length, FAMILY_A);
    await page.evaluate(({ family, reply }) => window.__messagingPreserve.resolvePending('ensure', family, reply),
      { family: FAMILY_A, reply: late === 'success' ? { data: CHAT_A, error: null }
        : { data: null, error: { code: '42501', message: 'Late old authorization failure' } } });
    await flushBrowser(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /messagesModule.familyChat/ })).toHaveCount(1);
    await liveMessageChannel(page, CHAT_B);
    expect(await page.evaluate(id => window.__messagingPreserve.channels
      .filter(channel => channel.topic.startsWith('msgs:' + id + ':') && !channel.removed).length, CHAT_A)).toBe(0);
    expect(await page.evaluate(family => window.__messagingPreserve.calls.filter(c => c.family === family && c.url.includes('/family_conversations')).length, FAMILY_A)).toBe(before);
  });
}

test('removed realtime callbacks and mismatched current-channel payloads cannot change the current thread', async ({ page }) => {
  await start(page, { ...base(), messages: { [CHAT_A]: [message('shared-id', FAMILY_A, CHAT_A, 'Original old scope message')],
    [CHAT_B]: [message('shared-id', FAMILY_B, CHAT_B, 'Current scope message')] } });
  await expect(page.getByText('Original old scope message', { exact: true })).toBeVisible();
  const oldChannel = await liveMessageChannel(page, CHAT_A);
  await page.evaluate(({ family, user }) => window.__messagingPreserve.switchScope(family, user), { family: FAMILY_B, user: USER_B });
  await expect(page.getByText('Current scope message', { exact: true })).toBeVisible();
  const currentChannel = await liveMessageChannel(page, CHAT_B);
  expect(await page.evaluate(id => window.__messagingPreserve.channels.find(ch => ch.id === id)!.removed, oldChannel)).toBe(true);
  await page.evaluate(({ oldChannel, currentChannel, oldInsert, oldUpdate, wrongFamily, wrongConversation, valid }) => {
    window.__messagingPreserve.emit(oldChannel, 'INSERT', oldInsert);
    window.__messagingPreserve.emit(oldChannel, 'UPDATE', oldUpdate);
    window.__messagingPreserve.emit(currentChannel, 'INSERT', wrongFamily);
    window.__messagingPreserve.emit(currentChannel, 'UPDATE', wrongConversation);
    window.__messagingPreserve.emit(currentChannel, 'INSERT', valid);
  }, { oldChannel, currentChannel,
    oldInsert: message('late-old-insert', FAMILY_A, CHAT_A, 'Late old insert'),
    oldUpdate: message('shared-id', FAMILY_A, CHAT_A, 'Late old update'),
    wrongFamily: message('wrong-family', FAMILY_A, CHAT_B, 'Wrong family payload'),
    wrongConversation: message('shared-id', FAMILY_B, CHAT_A, 'Wrong conversation update'),
    valid: message('valid-current', FAMILY_B, CHAT_B, 'Valid current realtime insert') });
  await expect(page.getByText('Valid current realtime insert', { exact: true })).toBeVisible();
  await expect(page.getByText('Current scope message', { exact: true })).toBeVisible();
  for (const text of ['Late old insert', 'Late old update', 'Wrong family payload', 'Wrong conversation update']) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
});

test('a denied read-receipt RPC never falls back to a raw message update', async ({ page }) => {
  await start(page, { ...base(), messages: { [CHAT_A]: [{ ...message('unread', FAMILY_A, CHAT_A, 'Unread synthetic message'), read_by: [] }] },
    readError: { code: '42501', message: 'Synthetic authorization denial' } });
  await expect(page.getByText('Unread synthetic message', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__messagingPreserve.calls.filter(c => c.url.includes('/rpc/mark_conversation_read')).length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__messagingPreserve.calls.filter(c => c.method === 'PATCH'))).toEqual([]);
});

test('a missing read-receipt RPC refuses a raw write and preserves other readers', async ({ page }) => {
  await start(page, { ...base(), messages: { [CHAT_A]: [{ ...message('unread-fallback', FAMILY_A, CHAT_A, 'Missing RPC fallback message'), read_by: [USER_B] }] },
    readError: { code: 'PGRST202', message: 'Synthetic missing procedure' } });
  await expect(page.getByText('Missing RPC fallback message', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => window.__messagingPreserve.calls.filter(c => c.method === 'PATCH'))).toEqual([]);
});

const sendFixture = (rejectSend: boolean): Config => ({
  ...base(), deferSend: true, rejectSend,
  conversations: { ...base().conversations, [FAMILY_A]: [
    conversation(OLD, FAMILY_A, 'Old private group'),
    conversation(CHAT_A, FAMILY_A, 'Canonical A', true),
  ] },
  messages: {
    [OLD]: [message('old-reply', FAMILY_A, OLD, 'Old private reply target')],
    [CHAT_A]: [message('current-a', FAMILY_A, CHAT_A, 'Current A thread')],
    [CHAT_B]: [message('current-b', FAMILY_B, CHAT_B, 'Current B thread')],
  },
});
async function pendingSend(page: Page, index: number) {
  await expect.poll(() => page.evaluate(() => window.__messagingPreserve.pending
    .filter(row => row.kind === 'send').length)).toBe(index + 1);
  return page.evaluate(position => window.__messagingPreserve.pending
    .filter(row => row.kind === 'send')[position].id, index);
}
async function failSend(page: Page, id: number, rejected: boolean) {
  await page.evaluate(({ id, rejected }) => {
    if (rejected) window.__messagingPreserve.rejectPendingAt(id, 'Synthetic rejected send fetch');
    else window.__messagingPreserve.resolvePendingAt(id, {
      data: null, error: { code: '42501', message: 'Synthetic send authorization denial' },
    });
  }, { id, rejected });
  await flushBrowser(page);
}
async function replyWithPrivateDraft(page: Page) {
  await page.getByRole('button', { name: /Old private group/ }).click();
  await expect(page.getByText('Old private reply target', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'a11y.reply', exact: true }).click();
  await expect(page.getByText('messages.replyingTo', { exact: false })).toBeVisible();
  await page.getByPlaceholder('messages.typeAMessage').fill('Private unsent draft from old scope');
  await page.getByRole('button', { name: 'messages.sendMessage', exact: true }).click();
  const id = await pendingSend(page, 0);
  const request = await page.evaluate(() => window.__messagingPreserve.calls
    .find(call => call.method === 'POST' && call.url.includes('/family_messages'))!);
  expect(request.body).toMatchObject({
    conversation_id: OLD, family_id: FAMILY_A, sender_id: USER_A,
    content: 'Private unsent draft from old scope', reply_to_id: 'old-reply',
  });
  await expect(page.getByPlaceholder('messages.typeAMessage')).toHaveValue('Private unsent draft from old scope');
  return id;
}

for (const rejected of [false, true]) {
  const result = rejected ? 'rejected fetch' : 'SDK error result';
  for (const switched of ['family', 'user', 'thread'] as const) {
    test('a late send ' + result + ' after a ' + switched + ' switch preserves the new draft and pending-send state', async ({ page }) => {
      await start(page, sendFixture(rejected));
      const oldSend = await replyWithPrivateDraft(page);
      if (switched === 'thread') await page.getByRole('button', { name: /messagesModule.familyChat/ }).click();
      else await page.evaluate(({ family, user }) => window.__messagingPreserve.switchScope(family, user),
        { family: switched === 'family' ? FAMILY_B : FAMILY_A, user: switched === 'user' ? USER_B : USER_A });
      await expect(page.getByText(switched === 'family' ? 'Current B thread' : 'Current A thread', { exact: true })).toBeVisible();
      const input = page.getByPlaceholder('messages.typeAMessage');
      await input.fill('New scope message');
      const sendButton = page.getByRole('button', { name: 'messages.sendMessage', exact: true });
      await expect(sendButton).toBeEnabled();
      await sendButton.click();
      const currentSend = await pendingSend(page, 1);
      await input.fill('Current scope follow-up draft');
      await expect(sendButton).toBeDisabled();
      await failSend(page, oldSend, rejected);
      await expect(input).toHaveValue('Current scope follow-up draft');
      await expect(sendButton).toBeDisabled();
      await expect(page.getByText('messages.replyingTo', { exact: false })).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await page.evaluate(() => window.__messagingPreserve.calls
        .filter(call => call.method === 'POST' && call.url.includes('/family_messages')).length)).toBe(2);
      await page.evaluate(id => window.__messagingPreserve.resolvePendingAt(id, { data: null, error: null }), currentSend);
      await flushBrowser(page);
      await expect(input).toHaveValue('Current scope follow-up draft');
      await expect(sendButton).toBeEnabled();
    });
  }

  test('a current send ' + result + ' restores its own draft and reply and clears its pending state', async ({ page }) => {
    await start(page, sendFixture(rejected));
    const id = await replyWithPrivateDraft(page);
    await failSend(page, id, rejected);
    await expect(page.getByPlaceholder('messages.typeAMessage')).toHaveValue('Private unsent draft from old scope');
    await expect(page.getByText('messages.replyingTo', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'messages.sendMessage', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toBeVisible();
  });
}

const voiceButton = (page: Page) => page.getByRole('button', { name: 'messages.recordVoiceMessage', exact: true });
const cancelVoiceButton = (page: Page) => page.getByRole('button', { name: 'messages.cancelRecording', exact: true });
async function resolveMedia(page: Page, id: number) {
  await expect.poll(() => page.evaluate(() => window.__messagingPreserve.media.requests.length)).toBe(id + 1);
  await page.evaluate(position => window.__messagingPreserve.resolveMedia(position), id);
  await flushBrowser(page);
}

for (const switched of ['family', 'user', 'thread'] as const) {
  test('microphone permission resolved after a ' + switched + ' switch stops the old stream without creating a recorder', async ({ page }) => {
    await start(page, { ...sendFixture(false), media: true });
    await page.getByRole('button', { name: /Old private group/ }).click();
    await expect(page.getByText('Old private reply target', { exact: true })).toBeVisible();
    await voiceButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__messagingPreserve.media.requests.length)).toBe(1);
    if (switched === 'thread') await page.getByRole('button', { name: /messagesModule.familyChat/ }).click();
    else await page.evaluate(({ family, user }) => window.__messagingPreserve.switchScope(family, user),
      { family: switched === 'family' ? FAMILY_B : FAMILY_A, user: switched === 'user' ? USER_B : USER_A });
    await expect(page.getByText(switched === 'family' ? 'Current B thread' : 'Current A thread', { exact: true })).toBeVisible();
    await resolveMedia(page, 0);
    expect(await page.evaluate(() => window.__messagingPreserve.media.requests[0].tracksStopped)).toBe(1);
    expect(await page.evaluate(() => window.__messagingPreserve.media.recorders.length)).toBe(0);
    await expect(cancelVoiceButton(page)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // A current request still creates a recorder, so the stale result is not
    // ignored because recording was disabled for the entire fixture.
    await voiceButton(page).click();
    await resolveMedia(page, 1);
    await expect(cancelVoiceButton(page)).toBeVisible();
    expect(await page.evaluate(() => window.__messagingPreserve.media.recorders[0].streamId)).toBe(1);
    await cancelVoiceButton(page).click();
    await page.evaluate(() => window.__messagingPreserve.fireRecorderStop(0));
    await flushBrowser(page);
    await expect(voiceButton(page)).toBeVisible();
    expect(await page.evaluate(() => window.__messagingPreserve.media.requests[1].tracksStopped)).toBe(1);
  });
}

test('a delayed old recorder callback stops its own stream while the new recorder timer keeps ticking', async ({ page }) => {
  await start(page, { ...base(), media: true });
  await expect(voiceButton(page)).toBeVisible();
  await voiceButton(page).click();
  await resolveMedia(page, 0);
  await expect(cancelVoiceButton(page)).toBeVisible();
  await page.evaluate(() => window.__messagingPreserve.fireRecorderData(0));
  await page.evaluate(({ family, user }) => window.__messagingPreserve.switchScope(family, user),
    { family: FAMILY_B, user: USER_A });
  await expect(voiceButton(page)).toBeVisible();
  expect(await page.evaluate(() => window.__messagingPreserve.media.recorders[0].stopCalls)).toBe(1);
  await voiceButton(page).click();
  await resolveMedia(page, 1);
  await expect(cancelVoiceButton(page)).toBeVisible();
  const timer = page.locator('span[aria-live="polite"]');
  const beforeOldStop = await timer.textContent();
  await page.evaluate(() => {
    window.__messagingPreserve.fireRecorderData(0);
    window.__messagingPreserve.fireRecorderStop(0);
  });
  await flushBrowser(page);
  await page.clock.fastForward(1100);
  await expect(timer).not.toHaveText(beforeOldStop!);
  await expect(cancelVoiceButton(page)).toBeVisible();
  expect(await page.evaluate(() => window.__messagingPreserve.media.requests[0].tracksStopped)).toBe(1);
  expect(await page.evaluate(() => window.__messagingPreserve.media.requests[1].tracksStopped)).toBe(0);
  expect(await page.evaluate(() => window.__messagingPreserve.media.recorders[1].state)).toBe('recording');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.__messagingPreserve.calls
    .filter(call => call.method === 'POST' && call.url.includes('/family_messages')))).toEqual([]);
  expect(await page.evaluate(() => window.__messagingPreserve.mediaWrites)).toBe(0);
  await cancelVoiceButton(page).click();
  await page.evaluate(() => {
    window.__messagingPreserve.fireRecorderData(1);
    window.__messagingPreserve.fireRecorderStop(1);
  });
  await flushBrowser(page);
  await expect(voiceButton(page)).toBeVisible();
  expect(await page.evaluate(() => window.__messagingPreserve.media.requests[1].tracksStopped)).toBe(1);
});

for (const active of [false, true]) {
  test('unmounting ' + (active ? 'an active recorder' : 'a pending microphone request') + ' stops its eventual stream and never uploads', async ({ page }) => {
    await start(page, { ...base(), media: true });
    await expect(voiceButton(page)).toBeVisible();
    await voiceButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__messagingPreserve.media.requests.length)).toBe(1);
    if (active) {
      await resolveMedia(page, 0);
      await expect(cancelVoiceButton(page)).toBeVisible();
      await page.evaluate(() => window.__messagingPreserve.fireRecorderData(0));
    }
    await page.evaluate(() => window.__messagingPreserve.unmount());
    if (active) {
      expect(await page.evaluate(() => window.__messagingPreserve.media.recorders[0].stopCalls)).toBe(1);
      await page.evaluate(() => {
        window.__messagingPreserve.fireRecorderData(0);
        window.__messagingPreserve.fireRecorderStop(0);
      });
    } else await resolveMedia(page, 0);
    await flushBrowser(page);
    expect(await page.evaluate(() => window.__messagingPreserve.media.requests[0].tracksStopped)).toBe(1);
    if (!active) expect(await page.evaluate(() => window.__messagingPreserve.media.recorders.length)).toBe(0);
    expect(await page.evaluate(() => window.__messagingPreserve.calls
      .filter(call => call.method === 'POST' && call.url.includes('/family_messages')))).toEqual([]);
    expect(await page.evaluate(() => window.__messagingPreserve.mediaWrites)).toBe(0);
  });
}


test('cap2 inbox includes the late canonical chat and completes two older-history windows', async ({ page }) => {
  const recent = Array.from({ length: 4 }, (_, i) => ({ ...conversation('recent-' + i, FAMILY_A, 'Recent group ' + i), last_message_at: WHEN }));
  const history = Array.from({ length: 60 }, (_, i) => ({ ...message('cap-message-' + String(i).padStart(3, '0'), FAMILY_A, CHAT_A, 'Capped history ' + i), created_at: new Date(Date.parse(WHEN) + i * 1000).toISOString() }));
  await start(page, { conversations: { [FAMILY_A]: [...recent, conversation(CHAT_A, FAMILY_A, 'Canonical', true)] }, messages: { [CHAT_A]: history }, serverCap: 2 });
  await expect(page.getByRole('button', { name: /messagesModule.familyChat/ })).toBeVisible();
  await expect(page.locator('[id^="message-cap-message-"]')).toHaveCount(50);
  await expect(page.locator('#message-cap-message-059')).toBeVisible();
  await expect(page.locator('#message-cap-message-000')).toHaveCount(0);
  await page.getByRole('button', { name: 'messagesChat.loadOlder', exact: true }).click();
  await expect(page.locator('[id^="message-cap-message-"]')).toHaveCount(60);
  await expect(page.getByRole('button', { name: 'messagesChat.loadOlder', exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => window.__messagingPreserve.calls);
  expect(calls.filter(call => call.url.includes('/family_conversations?')).some(call => new URL(call.url).searchParams.get('offset') === '4')).toBe(true);
  expect(calls.filter(call => call.url.includes('/rpc/family_conversation_overview?')).some(call => new URL(call.url).searchParams.get('offset') === '4')).toBe(true);
  expect(calls.filter(call => call.url.includes('/family_messages?') && new URL(call.url).searchParams.get('offset') === '50')).toHaveLength(1);
  expect(calls.filter(call => call.url.includes('/family_messages?')).every(call => call.family === FAMILY_A && call.conversation === CHAT_A)).toBe(true);
});

test('a denied later history page never publishes a prefix or a false empty state and can retry', async ({ page }) => {
  const history = Array.from({ length: 6 }, (_, i) => message('refused-' + i, FAMILY_A, CHAT_A, 'Refused history ' + i));
  await start(page, { ...base(), messages: { [CHAT_A]: history }, serverCap: 2, failMessageOffset: 2 });
  await expect(page.getByRole('button', { name: 'messagesChat.retryLoad', exact: true })).toBeVisible();
  await expect(page.locator('[id^="message-refused-"]')).toHaveCount(0);
  await expect(page.getByText('messages.noMessagesYet', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__messagingPreserve.configure({ failMessageOffset: undefined }));
  await page.getByRole('button', { name: 'messagesChat.retryLoad', exact: true }).click();
  await expect(page.locator('[id^="message-refused-"]')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'messagesChat.retryLoad', exact: true })).toHaveCount(0);
});


test('a failed complete inbox has persistent retry and never claims an empty accessible inbox', async ({ page }) => {
  const recent = Array.from({ length: 4 }, (_, i) => conversation('inbox-' + i, FAMILY_A, 'Inbox group ' + i));
  await start(page, { conversations: { [FAMILY_A]: [...recent, conversation(CHAT_A, FAMILY_A, 'Canonical', true)] }, serverCap: 2, failInboxOffset: 2 });
  await expect(page.getByRole('button', { name: 'messagesChat.retryLoad', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Inbox group/ })).toHaveCount(0);
  await expect(page.getByText('messages.noMessagesYet', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__messagingPreserve.configure({ failInboxOffset: undefined }));
  await page.getByRole('button', { name: 'messagesChat.retryLoad', exact: true }).click();
  await expect(page.getByRole('button', { name: /messagesModule.familyChat/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Inbox group/ })).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'messagesChat.retryLoad', exact: true })).toHaveCount(0);
});
