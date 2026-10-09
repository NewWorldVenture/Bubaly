import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real screen/provider and real turn controller, with native primitives and hooks
// simulated. Rendering deliberately does NOT flush effects: that is the privacy
// boundary these regressions exercise. This does not claim native device coverage.
const mobileRequire = createRequire(new URL('../mobile/package.json', import.meta.url));
const resolveNative = (name: string) => { try { return mobileRequire.resolve(name); } catch { return name; } };
const slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => void> = [];
let queued: Array<() => void> = [];
let holdUpdates = false;
let nextId = 0;
const hooks = {
  useState: (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (update: unknown) => {
      const apply = () => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; };
      if (holdUpdates) queued.push(apply); else apply();
    }];
  },
  useRef: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = cursor++; const previous = slots[index] as unknown[] | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { effects.push(effect); slots[index] = deps; }
  },
};
vi.doMock(resolveNative('react'), async () => ({ ...await vi.importActual<Record<string, unknown>>(resolveNative('react')), ...hooks }));
vi.doMock(resolveNative('react-native'), () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
  FlatList: 'FlatList', KeyboardAvoidingView: 'KeyboardAvoidingView', Linking: { openURL: vi.fn() }, Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View' }));
vi.doMock(resolveNative('expo-router'), () => ({ useFocusEffect: (effect: () => void) => hooks.useEffect(effect, []) }));
vi.doMock(resolveNative('expo-crypto'), () => ({ randomUUID: () => `conversation-${++nextId}` }));
vi.doMock(resolveNative('expo-audio'), () => ({ RecordingPresets: { HIGH_QUALITY: {} }, requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => {}, useAudioRecorder: () => ({ prepareToRecordAsync: async () => {}, record: () => {}, stop: async () => {}, uri: 'file:///voice.m4a' }) }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const name of ['AppText', 'Field', 'GlassCard', 'Pill', 'Screen']) {
  vi.doMock(`../mobile/src/components/${name}`, () => ({ [name]: name }));
}
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: {}, spacing: [0, 1, 2, 3, 4, 5], radius: {}, glass: {} }) }));
vi.doMock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://www.bubaly.com' }, webUrl: (path: string) => path }));
const ask = vi.fn();
const fetchConversations = vi.fn();
const fetchHistory = vi.fn();
vi.doMock('../mobile/src/lib/assistant-history', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/assistant-history'), fetchAssistantConversations: fetchConversations, fetchAssistantHistory: fetchHistory }));
vi.doMock('../mobile/src/lib/api', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/api'), askAssistant: ask }));
const family = { familyId: 'family-a', familyName: 'Private household A', timezone: 'UTC', memberId: 'member-a', role: 'parent', displayName: 'Parent' };
type Session = { user: { id: string }; access_token: string };
type AuthState = { ready: boolean; restoring: boolean; session: Session | null; accessToken: string | null; family: typeof family | null; familyLoading: boolean; familyError: string | null;
  signIn: unknown; signOut: unknown; refreshFamily: unknown; freshFamily: () => Promise<{ ok: true; family: typeof family | null }> };
let auth: AuthState;
let authEvent: (event: string, session: unknown) => void = () => {};
const passwordSignIn = vi.fn();
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: { auth: {
  signInWithPassword: passwordSignIn,
  getSession: async () => ({ data: { session: auth.session }, error: null }),
  onAuthStateChange: (listener: typeof authEvent) => { authEvent = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
} } }));
vi.doMock('../mobile/src/lib/family', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/family'), resolveActiveFamily: async () => family }));
vi.doMock('../mobile/src/lib/auth', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/auth'), useAuth: () => auth }));
// Web CI has no native dependencies. Keep native UI imports dynamic so the web
// typecheck does not absorb the separate mobile TS project; mobile CI checks it.
const screenModule = '../mobile/app/(tabs)/assistant';
const authModule = '../mobile/src/lib/auth';
const { default: AssistantScreen } = await import(screenModule);
const { AuthProvider } = await import(authModule);

type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node; return [node, ...nodes(node.props.children), ...nodes(node.props.right), ...nodes(node.props.ListHeaderComponent), ...nodes(node.props.ListFooterComponent)];
}
function find(tree: unknown, type: string, label?: string) {
  const value = nodes(tree).find((node) => node.type === type && (!label || node.props.accessibilityLabel === label));
  if (!value) throw new Error(`Missing ${type} ${label ?? ''}`); return value;
}
const render = () => { cursor = 0; return AssistantScreen(); };
const provider = () => { cursor = 0; return (AuthProvider({ children: null }) as unknown as Node).props.value as AuthState; };
const flushEffects = () => { const pending = effects; effects = []; pending.forEach((effect) => effect()); };
const click = (tree: unknown, label: string) => (find(tree, 'Pressable', label).props.onPress as () => void)();
const draft = (tree: unknown, text: string) => (find(tree, 'Field').props.onChangeText as (text: string) => void)(text);
const session = (id: string) => ({ user: { id }, access_token: `token-${id}` }) as AuthState['session'];
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  slots.length = 0; cursor = 0; effects = []; queued = []; holdUpdates = false; nextId = 0;
  ask.mockReset().mockResolvedValue({ conversationId: 'server-conversation', content: 'Private answer A', actions: [], persisted: true });
  fetchConversations.mockReset().mockResolvedValue({ conversations: [{ id: 'saved-a', title: 'Saved A' }, { id: 'saved-b', title: 'Saved B' }], hasMore: false });
  fetchHistory.mockReset().mockImplementation(async (_db, _owner, id) => ({ messages: [{ id: `${id}-message`, role: 'assistant', content: `Private history ${id}` }], before: null }));
  passwordSignIn.mockReset().mockResolvedValue({ error: null });
  auth = { ready: true, restoring: false, session: session('user-a'), accessToken: 'token-user-a', family: { ...family }, familyLoading: false, familyError: null,
    signIn: vi.fn(), signOut: vi.fn(), refreshFamily: vi.fn(), freshFamily: async () => ({ ok: true, family: auth.family }) };
});

describe('native saved assistant conversations', () => {
  const showHistory = async () => { click(render(), 'Saved conversations'); await settle(); return render(); };
  it('opens saved chats under the current owner and restores a draft to its own chat', async () => {
    render(); flushEffects(); await showHistory(); click(render(), 'Saved A'); await settle();
    draft(render(), 'Draft A');
    await showHistory(); click(render(), 'Saved B'); await settle();
    expect(find(render(), 'Field').props.value).toBe('');
    draft(render(), 'Draft B');
    await showHistory(); click(render(), 'Saved A'); await settle();
    expect(find(render(), 'Field').props.value).toBe('Draft A');
    expect(fetchConversations.mock.calls[0][1]).toEqual({ userId: 'user-a', familyId: 'family-a' });
    expect(fetchHistory.mock.calls[0][1]).toEqual({ userId: 'user-a', familyId: 'family-a' });
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ content: 'Private history saved-a' }]);
    click(render(), 'Send'); await settle();
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 'saved-a', message: 'Draft A' }));
  });

  it.each(['reset', 'owner', 'newer-read'])('ignores a held history response after %s and aborts the obsolete read', async (reason) => {
    let resolve!: (value: unknown) => void;
    fetchHistory.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(); flushEffects(); await showHistory(); click(render(), 'Saved A'); await settle();
    expect(find(render(), 'Field').props.editable).toBe(false);
    const signal = fetchHistory.mock.calls[0][3] as AbortSignal;
    if (reason === 'reset') click(render(), 'New conversation');
    if (reason === 'owner') { auth.session = session('user-b'); render(); flushEffects(); }
    if (reason === 'newer-read') { click(render(), 'Saved B'); await settle(); }
    render(); resolve({ messages: [{ id: 'late', role: 'assistant', content: 'Private late A' }], before: null }); await settle();
    expect(signal.aborted).toBe(true);
    expect(JSON.stringify(find(render(), 'FlatList').props.data)).not.toContain('Private late A');
    if (reason === 'owner') expect(nodes(render()).some((node) => node.props.accessibilityLabel === 'Saved A')).toBe(false);
  });

  it('keeps the current messages and draft after a failed read, and retries only that read', async () => {
    render(); flushEffects(); await showHistory(); click(render(), 'Saved A'); await settle(); draft(render(), 'Keep my draft');
    await showHistory(); fetchHistory.mockRejectedValueOnce(new Error('offline')); click(render(), 'Saved B'); await settle();
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ content: 'Private history saved-a' }]);
    expect(find(render(), 'Field').props.value).toBe('Keep my draft');
    click(render(), 'Retry conversation history'); await settle();
    expect(fetchHistory.mock.calls.at(-1)?.[2]).toBe('saved-b');
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ content: 'Private history saved-b' }]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('loads older saved history without losing the current transcript or resending anything', async () => {
    const before = { id: 'before-id', created_at: '2026-10-01T00:00:00Z' };
    fetchHistory.mockResolvedValueOnce({ messages: [{ id: 'new', role: 'assistant', content: 'Latest' }], before });
    render(); flushEffects(); await showHistory(); click(render(), 'Saved A'); await settle();
    fetchHistory.mockResolvedValueOnce({ messages: [{ id: 'old', role: 'user', content: 'Earlier' }], before: null });
    click(render(), 'Load earlier messages'); await settle();
    expect(fetchHistory.mock.calls.at(-1)?.[4]).toEqual(before);
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ content: 'Earlier' }, { content: 'Latest' }]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('Stop aborts the receiver, keeps the sent question, and offers history review without retrying the action', async () => {
    let resolve!: (value: unknown) => void; ask.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(); flushEffects(); draft(render(), 'Send groceries'); click(render(), 'Send'); await settle();
    click(render(), 'Stop');
    expect((ask.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    resolve({ content: 'Late private answer', persisted: true }); await settle();
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ role: 'user', content: 'Send groceries' }]);
    expect(find(render(), 'Pressable', 'Review saved conversation')).toBeDefined();
    click(render(), 'Review saved conversation'); await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(1); expect(ask).toHaveBeenCalledTimes(1);
  });

  it('queued result updates are invalidated by Stop even while staying in the same chat', async () => {
    let resolve!: (value: unknown) => void; ask.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(); flushEffects(); draft(render(), 'Save this'); click(render(), 'Send'); await settle();
    holdUpdates = true; resolve({ content: 'Queued result', persisted: true }); await settle();
    const delayed = queued; queued = []; holdUpdates = false;
    click(render(), 'Stop'); delayed.forEach((apply) => apply());
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ role: 'user', content: 'Save this' }]);
    expect(find(render(), 'Pressable', 'Review saved conversation')).toBeDefined();
  });

  it('network failure preserves the request for explicit editing and never automatically replays it', async () => {
    ask.mockRejectedValueOnce(new Error('offline'));
    render(); flushEffects(); draft(render(), 'Book a meal'); click(render(), 'Send'); await settle();
    click(render(), 'Edit and retry');
    expect(find(render(), 'Field').props.value).toBe('Book a meal');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(find(render(), 'Pressable', 'Review saved conversation')).toBeDefined();
  });
});

it('explains an overlapping sign-in failure without exposing SDK storage diagnostics', async () => {
  passwordSignIn.mockResolvedValue({ error: { code: 'session_write_blocked', message: 'internal session write diagnostic' } });
  const signIn = provider().signIn as (email: string, password: string) => Promise<{ error: string | null }>;
  expect(await signIn('fixture@example.test', 'synthetic-password')).toEqual({ error: 'Sign-out is finishing. Please try signing in again.' });
});

describe('assistant ownership at render time', () => {
  it.each(['household', 'user', 'member', 'role', 'signout'])('hides messages and drafts on the first %s render before effects run', async (change) => {
    render(); flushEffects(); let tree = render(); draft(tree, 'Private request A'); tree = render(); click(tree, 'Send'); await settle();
    tree = render(); draft(tree, 'Private unsent draft A'); tree = render();
    expect(find(tree, 'FlatList').props.data).toHaveLength(2); expect(find(tree, 'Field').props.value).toBe('Private unsent draft A');
    const oldDraft = find(tree, 'Field').props.onChangeText as (text: string) => void;
    const oldSend = find(tree, 'Pressable', 'Send').props.onPress as () => void;
    if (change === 'household') auth.family = { ...family, familyId: 'family-b', familyName: 'Household B' };
    if (change === 'user') auth.session = session('user-b');
    if (change === 'member') auth.family = { ...family, memberId: 'member-b' };
    if (change === 'role') auth.family = { ...family, role: 'child' };
    if (change === 'signout') { auth.session = null; auth.accessToken = null; auth.family = null; }
    tree = render(); // intentionally do not flush the queued context effect
    expect(find(tree, 'FlatList').props.data).toEqual([]); expect(find(tree, 'Field').props.value).toBe('');
    expect(find(tree, 'Field').props.editable).toBe(false); expect(find(tree, 'Pressable', 'Send').props.disabled).toBe(true);
    oldDraft('Late native edit from A'); oldSend(); await settle();
    expect(find(render(), 'Field').props.value).toBe(''); expect(ask).toHaveBeenCalledTimes(1);
    flushEffects(); tree = render(); oldDraft('Even later native edit from A'); oldSend(); await settle();
    expect(find(render(), 'Field').props.value).toBe(''); expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a queued result updater cannot append to a reset conversation', async () => {
    let resolve!: (value: unknown) => void; ask.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(); flushEffects(); let tree = render(); draft(tree, 'Private request A'); tree = render(); click(tree, 'Send'); await settle();
    holdUpdates = true; resolve({ content: 'Late private answer A', persisted: true }); await settle();
    const delayed = queued; queued = []; holdUpdates = false;
    click(render(), 'New conversation'); render(); delayed.forEach((apply) => apply());
    expect(find(render(), 'FlatList').props.data).toEqual([]); expect(find(render(), 'Field').props.value).toBe('');
  });
});

describe('auth family ownership at render time', () => {
  it.each(['SIGNED_IN', 'SIGNED_OUT'])('does not expose the prior user family before the %s cleanup effect', async (event) => {
    provider(); flushEffects(); await settle(); provider(); flushEffects(); await settle();
    expect(provider().family?.familyName).toBe('Private household A');
    authEvent(event, event === 'SIGNED_OUT' ? null : session('user-b'));
    const changed = provider(); // hold effects from the new user render
    expect(changed.family).toBeNull(); expect(changed.familyError).toBeNull();
    expect(changed.familyLoading).toBe(event !== 'SIGNED_OUT');
    expect(changed.session?.user.id ?? null).toBe(event === 'SIGNED_OUT' ? null : 'user-b');
  });
});
