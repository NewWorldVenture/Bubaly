// The App Lock screen asks the server, and never holds the app.
//
// The gate used to take `salt`, `hash` and `children`, check the PIN in the
// browser with verifyPin, and keep its five-try limit in React state. Now the
// layout renders it only when the server has decided the browser is locked
// (tests/app-lock-is-enforced-on-the-server.test.ts), and it sends each PIN to
// unlockAppAction. A right PIN asks the router to re-render, which brings the
// app; a refusal from the durable limiter shows the server's countdown. Driven
// through the REAL component on the module harness.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, has, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const state = vi.hoisted(() => {
  const refresh = vi.fn();
  // One router for the life of the page, as Next's useRouter gives.
  return { unlock: vi.fn(), refresh, router: { refresh: (...args: unknown[]) => refresh(...args) } };
});

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('next/navigation', () => ({ useRouter: () => state.router }));
vi.mock('@/components/auth/sign-out-form', () => ({
  SignOutForm: ({ children }: { children: (s: { signingOut: boolean }) => unknown }) => createElement('form', { action: '/auth/signout' }, children({ signingOut: false }) as never),
}));
vi.mock('@/app/(app)/settings/app-lock-actions', () => ({ unlockAppAction: (pin: string) => state.unlock(pin) }));
vi.mock('@/lib/hooks/use-lock-body-scroll', () => ({ useLockBodyScroll: () => {} }));
vi.mock('@/lib/a11y/use-dialog-behavior', () => ({ useDialogBehavior: () => {} }));

const { AppLockGate } = await import('@/components/app/app-lock-gate');

const screen = () => render(h.hooks, createElement(AppLockGate));

async function enter(pin: string) {
  for (const digit of pin) await click(byName(screen(), digit) as Node);
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  state.unlock.mockReset();
  state.refresh.mockReset();
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the App Lock screen', () => {
  it('takes no salt, hash or app content — the layout gives it none', () => {
    expect(AppLockGate.length).toBe(0);
    const tree = screen();
    expect(has(tree, 'Enter your PIN')).toBe(true);
    expect(has(tree, 'Forgot PIN? Sign out')).toBe(true);
  });

  it('sends the PIN to the server, and on a right one re-renders into the app', async () => {
    state.unlock.mockResolvedValue({ ok: true });
    await enter('4071');
    expect(state.unlock).toHaveBeenCalledTimes(1);
    expect(state.unlock).toHaveBeenCalledWith('4071');
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('a wrong PIN is said, and nothing re-renders', async () => {
    state.unlock.mockResolvedValue({ ok: false, reason: 'wrong_pin' });
    await enter('0000');
    expect(has(screen(), 'Wrong PIN — try again')).toBe(true);
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("the server's refusal holds the keypad for the time it names", async () => {
    state.unlock.mockResolvedValue({ ok: false, reason: 'rate_limited', retryAfter: 240 });
    await enter('4071');
    const tree = screen();
    expect(has(tree, 'Too many attempts — try again in')).toBe(true);
    expect(byName(tree, '1').props.disabled).toBe(true);
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it('a check that could not run is not called a wrong PIN', async () => {
    state.unlock.mockRejectedValue(new Error('Failed to fetch'));
    await enter('4071');
    const tree = screen();
    expect(has(tree, 'Wrong PIN — try again')).toBe(false);
    expect(has(tree, 'Your app is staying locked until we can check.')).toBe(true);
  });
});
