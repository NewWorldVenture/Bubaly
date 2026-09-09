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
  FlatList: 'FlatList', KeyboardAvoidingView: 'KeyboardAvoidingView', Linking: { openURL: vi.fn() }, Platform: { OS: 'ios' }, Pressable: 'Pressable', View: 'View' }));
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
vi.doMock('../mobile/src/lib/api', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/api'), askAssistant: ask }));
const family = { familyId: 'family-a', familyName: 'Private household A', timezone: 'UTC', memberId: 'member-a', role: 'parent', displayName: 'Parent' };
type Session = { user: { id: string }; access_token: string };
type AuthState = { ready: boolean; restoring: boolean; session: Session | null; accessToken: string | null; family: typeof family | null; familyLoading: boolean; familyError: string | null;
  signIn: unknown; signOut: unknown; refreshFamily: unknown; freshFamily: () => Promise<{ ok: true; family: typeof family | null }> };
let auth: AuthState;
let authEvent: (event: string, session: unknown) => void = () => {};
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: { auth: {
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
  const node = value as Node; return [node, ...nodes(node.props.children), ...nodes(node.props.right)];
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
  auth = { ready: true, restoring: false, session: session('user-a'), accessToken: 'token-user-a', family: { ...family }, familyLoading: false, familyError: null,
    signIn: vi.fn(), signOut: vi.fn(), refreshFamily: vi.fn(), freshFamily: async () => ({ ok: true, family: auth.family }) };
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
