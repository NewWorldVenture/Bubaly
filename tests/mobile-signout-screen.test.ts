import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mobileRequire = createRequire(new URL('../mobile/package.json', import.meta.url));
const resolveNative = (name: string) => { try { return mobileRequire.resolve(name); } catch { return name; } };
const slots: unknown[] = []; let cursor = 0;
vi.doMock(resolveNative('react'), async () => ({ ...await vi.importActual<Record<string, unknown>>(resolveNative('react')),
  useState: (initial: unknown) => {
    const index = cursor++; if (!(index in slots)) slots[index] = initial;
    return [slots[index], (next: unknown) => { slots[index] = next; }];
  },
}));
vi.doMock(resolveNative('react-native'), () => ({ View: 'View', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' }));
vi.doMock(resolveNative('expo-linking'), () => ({ openURL: vi.fn() }));
vi.doMock(resolveNative('expo-constants'), () => ({ default: { expoConfig: { version: 'test' } } }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const component of ['AppText', 'Button', 'GlassCard', 'Screen']) vi.doMock(`../mobile/src/components/${component}`, () => ({ [component]: component }));
vi.doMock('../mobile/src/components/ListRow', () => ({ Divider: 'Divider', ListRow: 'ListRow' }));
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: { danger: 'red' }, spacing: [0, 4, 8, 12, 16, 20], radius: {}, layout: { touchTarget: 44 }, setPreference: vi.fn() }) }));
vi.doMock('../mobile/src/lib/config', () => ({ webUrl: (path: string) => path }));
const signOut = vi.fn();
vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => ({ signOut, session: null, family: null }) }));
vi.doMock('../mobile/src/lib/mobile-i18n', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/mobile-i18n'), deviceLocale: () => 'en-US' }));
// Dynamic imports keep the native app out of the independent web TS project.
const reconnectingModule = '../mobile/src/components/ReconnectingScreen'; const settingsModule = '../mobile/app/settings';
const { ReconnectingScreen } = await import(reconnectingModule); const { default: SettingsScreen } = await import(settingsModule);
type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node; return [node, ...nodes(node.props.children)];
}
beforeEach(() => { slots.length = 0; cursor = 0; signOut.mockReset(); });
describe.each([['reconnecting', ReconnectingScreen], ['settings', SettingsScreen]])('%s device sign-out', (_name, Screen) => {
  const render = () => { cursor = 0; return nodes(Screen()); };
  const button = (tree: Node[]) => tree.find(node => node.type === 'Button')!;
  it('shows deletion failures and allows an explicit retry', async () => {
    signOut.mockRejectedValueOnce(new Error('private native diagnostic')).mockResolvedValue(undefined);
    await (button(render()).props.onPress as () => Promise<void>)();
    const failed = render();
    expect(failed.find(node => node.props.accessibilityRole === 'alert')?.props.children).toBe('Could not sign out on this device. Please try again.');
    expect(JSON.stringify(failed)).not.toContain('private native diagnostic');
    expect(button(failed).props.loading).toBe(false);
    await (button(failed).props.onPress as () => Promise<void>)();
    expect(render().find(node => node.props.accessibilityRole === 'alert')).toBeUndefined();
    expect(signOut).toHaveBeenCalledTimes(2);
  });
  it('keeps the action busy until sign-out finishes', async () => {
    let resolve!: () => void; signOut.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const ending = (button(render()).props.onPress as () => Promise<void>)();
    expect(button(render()).props.loading).toBe(true);
    resolve(); await ending; expect(button(render()).props.loading).toBe(false);
  });
});
