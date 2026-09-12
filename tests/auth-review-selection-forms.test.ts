import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignupForm } from '@/components/auth/signup-form';
import { LoginForm } from '@/components/auth/login-form';
import { OAuthButtons } from '@/components/auth/oauth-buttons';
import { PhoneAuth } from '@/components/auth/phone-auth';
import { getMessages, getRawMessages } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { ReviewPlan } from '@/lib/billing/review-selection';

const mock = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[],
  query: new URLSearchParams(), locale: 'en-US' as LocaleCode,
  push: vi.fn(), refresh: vi.fn(), toast: vi.fn(), stitch: vi.fn(), landing: vi.fn(), referral: vi.fn(),
  signUp: vi.fn(), password: vi.fn(), oauth: vi.fn(), otp: vi.fn(), verify: vi.fn(), fetch: vi.fn(),
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  function effectSlot(effect: () => void | (() => void), deps: readonly unknown[] = []) {
    const index = mock.cursor++;
    const previous = mock.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && deps.every((item, i) => Object.is(item, previous[i]))) return;
    mock.slots[index] = deps;
    mock.effects.push(() => { const cleanup = effect(); if (typeof cleanup === 'function') mock.cleanups.push(cleanup); });
  }
  return {
  ...actual,
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.slots)) mock.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [mock.slots[index], (value: unknown) => {
      mock.slots[index] = typeof value === 'function' ? value(mock.slots[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.slots)) mock.slots[index] = { current: initial };
    return mock.slots[index];
  },
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
    const index = mock.cursor++;
    const previous = mock.slots[index] as { deps: readonly unknown[]; value: unknown } | undefined;
    if (previous && previous.deps.length === deps.length && deps.every((item, i) => Object.is(item, previous.deps[i]))) return previous.value;
    const value = factory(); mock.slots[index] = { deps, value }; return value;
  },
  useEffect: effectSlot,
  useLayoutEffect: effectSlot,
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mock.push, refresh: mock.refresh }), useSearchParams: () => mock.query }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: ReactNode }) => ({ type: 'a', props: { ...props, children }, $$typeof: Symbol.for('react.element') }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: mock.toast, success: mock.toast }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { getMessages } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, params?: Record<string, string>) => Object.entries(params ?? {})
    .reduce((text, [name, value]) => text.replace(`{${name}}`, value), getMessages(mock.locale)[key] ?? key) };
});
vi.mock('@/components/auth/legal-consent', () => ({ LegalConsent: () => null }));
vi.mock('@/components/auth/recovery-form', () => ({ RecoveryForm: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: {
  signUp: mock.signUp, signInWithPassword: mock.password, signInWithOAuth: mock.oauth,
  signInWithOtp: mock.otp, verifyOtp: mock.verify,
} }) }));
vi.mock('@/lib/auth/signup-client', () => ({
  signUpWithOwnedVerifier: (_client: unknown, credentials: unknown) => mock.signUp(credentials),
}));
vi.mock('@/app/(auth)/actions', () => ({ resolveLandingPathAction: mock.landing, stitchIdentityAction: mock.stitch }));
vi.mock('@/app/(auth)/signup/actions', () => ({ rememberReferralCodeAction: mock.referral }));

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function render<T>(factory: () => T): T {
  mock.cursor = 0;
  const value = factory();
  mock.effects.splice(0).forEach((effect) => effect());
  return value;
}
function resetHooks() { mock.cleanups.splice(0).forEach((cleanup) => cleanup()); mock.slots = []; mock.effects = []; }
function click(tree: ReactNode, label: string) {
  const target = nodes(tree).find((node) => typeof node.props.onClick === 'function' && textOf(node.props.children as ReactNode).trim() === label);
  expect(target, `Missing button ${label}`).toBeDefined();
  return (target!.props.onClick as () => unknown)();
}
function links(tree: ReactNode) { return nodes(tree).filter((node) => typeof node.props.href === 'string').map((node) => String(node.props.href)); }
async function submit(tree: ReactNode) {
  const form = nodes(tree).find((node) => node.type === 'form');
  expect(form).toBeDefined();
  await (form!.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: {
    fullName: 'Taylor Example', email: 'taylor@example.test', password: 'fixture-password',
  } });
}
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
const choices: [string, ReviewPlan][] = [
  ['plan=basic&billing=monthly', 'basic_monthly'], ['plan=basic&billing=yearly', 'basic_annual'],
  ['plan=plus&billing=monthly', 'plus_monthly'], ['plan=plus&billing=yearly', 'plus_annual'],
];
const signupUser = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'taylor@example.test', aud: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' };

beforeEach(() => {
  resetHooks(); vi.clearAllMocks();
  mock.query = new URLSearchParams(); mock.locale = 'en-US';
  mock.signUp.mockReset().mockResolvedValue({ data: { user: signupUser, session: { user: signupUser,
    access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', token_type: 'bearer', expires_in: 3600 } }, error: null });
  mock.stitch.mockReset().mockResolvedValue(undefined);
  mock.referral.mockReset().mockResolvedValue(undefined);
  mock.password.mockReset().mockResolvedValue({ error: null });
  mock.oauth.mockReset().mockResolvedValue({ error: null });
  mock.otp.mockReset().mockResolvedValue({ error: null });
  mock.verify.mockReset().mockResolvedValue({ error: null });
  mock.landing.mockReset().mockResolvedValue('/home');
  vi.stubGlobal('window', { location: { origin: 'https://bubaly.test', hash: '', href: 'https://bubaly.test/login' } });
  vi.stubGlobal('FormData', class { constructor(private fields: Record<string, string>) {} get(name: string) { return this.fields[name]; } });
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => { expect(mock.fetch).not.toHaveBeenCalled(); resetHooks(); vi.unstubAllGlobals(); });

describe.each(choices)('auth handoff for %s', (query, plan) => {
  const destination = `/onboarding?reviewPlan=${plan}`;
  it('carries the selected interval through immediate email signup and metadata stays referral-only', async () => {
    mock.query = new URLSearchParams(`${query}&ref=smith-7k4q`);
    const initial = render(SignupForm);
    expect(links(initial)).toContain(`/login?reviewPlan=${plan}`);
    expect(mock.signUp).not.toHaveBeenCalled();
    expect(mock.stitch).not.toHaveBeenCalled();
    expect(mock.referral).toHaveBeenCalledWith('SMITH-7K4Q');
    click(initial, getMessages('en-US')['signup.continueWithEmail']);
    await submit(render(SignupForm));
    expect(mock.push).toHaveBeenCalledWith(destination);
    expect(mock.stitch).toHaveBeenCalledTimes(1);
    const options = mock.signUp.mock.calls[0][0].options;
    expect(options.data).toEqual({ full_name: 'Taylor Example', referral_code: 'SMITH-7K4Q' });
    expect(new URL(options.emailRedirectTo).searchParams.get('next')).toBe(destination);
  });

  it('preserves confirmation and check-email login links without navigating before a session exists', async () => {
    mock.query = new URLSearchParams(query);
    mock.signUp.mockResolvedValueOnce({ data: { user: signupUser, session: null }, error: null });
    click(render(SignupForm), getMessages('en-US')['signup.continueWithEmail']);
    await submit(render(SignupForm));
    expect(links(render(SignupForm))).toEqual([`/login?reviewPlan=${plan}`]);
    expect(new URL(mock.signUp.mock.calls[0][0].options.emailRedirectTo).searchParams.get('next')).toBe(destination);
    expect(mock.push).not.toHaveBeenCalled();
    expect(mock.stitch).not.toHaveBeenCalled();
  });

  it('preserves login/signup swaps, password login, and the existing role resolver only as fallback', async () => {
    mock.query = new URLSearchParams({ reviewPlan: plan });
    const tree = render(LoginForm);
    expect(links(tree)).toContain(`/signup?reviewPlan=${plan}`);
    await submit(tree);
    expect(mock.push).toHaveBeenCalledWith(destination);
    expect(mock.landing).not.toHaveBeenCalled();
  });

  it('passes one destination from each auth screen to the real Google and SMS components', async () => {
    for (const Form of [SignupForm, LoginForm]) {
      resetHooks(); mock.query = new URLSearchParams({ reviewPlan: plan });
      const screen = render(Form);
      const google = nodes(screen).find((node) => node.type === OAuthButtons)!;
      expect(google.props.next).toBe(destination);
      const phoneLabel = Form === SignupForm ? 'signup.continueWithPhone' : 'login.continueWithPhone';
      click(screen, getMessages('en-US')[phoneLabel]);
      const phone = nodes(render(Form)).find((node) => node.type === PhoneAuth)!;
      expect(phone.props.next).toBe(destination);
      resetHooks();
      await click(render(() => OAuthButtons({ next: String(google.props.next) })), getMessages('en-US')['oauthButtons.continueWithGoogle']);
      const oauth = mock.oauth.mock.calls.at(-1)![0];
      expect(oauth.provider).toBe('google');
      expect(new URL(oauth.options.redirectTo).searchParams.get('next')).toBe(destination);
      resetHooks();
      const phoneTree = render(() => PhoneAuth({ next: String(phone.props.next) }));
      const input = nodes(phoneTree).find((node) => node.props.defaultCountryCode === 'US')!;
      (input.props.onChange as (number: string) => void)('+15555550123');
      await click(render(() => PhoneAuth({ next: destination })), getMessages('en-US')['phoneAuth.continue']);
      const codeTree = render(() => PhoneAuth({ next: destination }));
      const otp = nodes(codeTree).find((node) => typeof node.props.onComplete === 'function')!;
      (otp.props.onComplete as (code: string) => void)('123456'); await settle();
      expect(mock.verify).toHaveBeenLastCalledWith({ phone: '+15555550123', token: '123456', type: 'sms' });
      expect(mock.push).toHaveBeenLastCalledWith(destination);
    }
  });
});

describe('explicit destinations, failures and defaults', () => {
  it.each(['/join?token=invite-fixture#accept', '/dashboard/billing?view=manage#plan'])('preserves %s over a pricing choice on both screens and in email confirmation', async (next) => {
    mock.query = new URLSearchParams({ reviewPlan: 'plus_annual', redirect: next });
    for (const Form of [SignupForm, LoginForm]) {
      resetHooks();
      const tree = render(Form);
      const link = links(tree).find((href) => href.startsWith(Form === SignupForm ? '/login' : '/signup'))!;
      expect(new URL(link, 'https://bubaly.test').searchParams.get('redirect')).toBe(next);
      expect(link).not.toContain('reviewPlan');
      expect(nodes(tree).find((node) => node.type === OAuthButtons)?.props.next).toBe(next);
      if (Form === SignupForm) click(tree, getMessages('en-US')['signup.continueWithEmail']);
      await submit(render(Form));
      expect(mock.push).toHaveBeenLastCalledWith(next);
    }
    expect(new URL(mock.signUp.mock.calls[0][0].options.emailRedirectTo).searchParams.get('next')).toBe(next);
  });

  it('retains the annual choice after failed email, password, and Google attempts', async () => {
    mock.query = new URLSearchParams({ reviewPlan: 'plus_annual' });
    mock.signUp.mockResolvedValueOnce({ data: { user: null, session: null }, error: { name: 'AuthApiError', status: 400, message: 'try again' } });
    click(render(SignupForm), getMessages('en-US')['signup.continueWithEmail']);
    await submit(render(SignupForm));
    expect(mock.push).not.toHaveBeenCalled();
    await submit(render(SignupForm));
    expect(mock.push).toHaveBeenLastCalledWith('/onboarding?reviewPlan=plus_annual');
    resetHooks(); mock.push.mockClear();
    mock.password.mockResolvedValueOnce({ error: new Error('try again') });
    await submit(render(LoginForm));
    expect(mock.push).not.toHaveBeenCalled();
    await submit(render(LoginForm));
    expect(mock.push).toHaveBeenLastCalledWith('/onboarding?reviewPlan=plus_annual');
    resetHooks();
    mock.oauth.mockResolvedValueOnce({ error: new Error('cancelled') });
    for (let i = 0; i < 2; i++) await click(render(() => OAuthButtons({ next: '/onboarding?reviewPlan=plus_annual' })), getMessages('en-US')['oauthButtons.continueWithGoogle']);
    expect(mock.oauth).toHaveBeenCalledTimes(2);
    for (const [input] of mock.oauth.mock.calls) expect(new URL(input.options.redirectTo).searchParams.get('next')).toBe('/onboarding?reviewPlan=plus_annual');
  });

  it('retains an SMS review after a rejected verification', async () => {
    const factory = () => PhoneAuth({ next: '/onboarding?reviewPlan=basic_annual' });
    const input = nodes(render(factory)).find((node) => node.props.defaultCountryCode === 'US')!;
    (input.props.onChange as (number: string) => void)('+15555550123');
    await click(render(factory), getMessages('en-US')['phoneAuth.continue']);
    mock.verify.mockResolvedValueOnce({ error: { message: 'try again' } });
    for (let i = 0; i < 2; i++) {
      const otp = nodes(render(factory)).find((node) => typeof node.props.onComplete === 'function')!;
      (otp.props.onComplete as (code: string) => void)('123456'); await settle();
      if (i === 0) expect(mock.push).not.toHaveBeenCalled();
    }
    expect(mock.push).toHaveBeenCalledWith('/onboarding?reviewPlan=basic_annual');
  });

  it.each(['/admin', '/grandparent', '/home'])('keeps ordinary password landing %s when no selection exists', async (path) => {
    mock.landing.mockResolvedValue(path);
    const tree = render(LoginForm);
    expect(nodes(tree).find((node) => node.type === OAuthButtons)?.props.next).toBeUndefined();
    click(tree, getMessages('en-US')['login.continueWithPhone']);
    expect(nodes(render(LoginForm)).find((node) => node.type === PhoneAuth)?.props.next).toBe('/dashboard');
    resetHooks(); await submit(render(LoginForm));
    expect(mock.push).toHaveBeenCalledWith(path);
    expect(mock.landing).toHaveBeenCalledTimes(1);
  });

  it.each<LocaleCode>(['en-US', 'de-DE', 'fr-FR', 'pt-PT', 'es-ES', 'it-IT', 'nl-NL'])('uses localized review copy in %s and never interpolates raw plan input', (locale) => {
    mock.locale = locale;
    mock.query = new URLSearchParams({ reviewPlan: 'plus_annual' });
    const selected = textOf(render(SignupForm));
    expect(selected).toContain(`${getRawMessages(locale)['signup.oneCalmHomeForYourCalendar']}. ${getRawMessages(locale)['signup.reviewSelectedPlanAfterSetup']}`);
    mock.query = new URLSearchParams({ plan: 'RAW_UNTRUSTED_TIER', billing: 'yearly' });
    const invalid = renderToStaticMarkup(render(SignupForm));
    expect(invalid).not.toContain('RAW_UNTRUSTED_TIER');
    expect(textOf(render(SignupForm))).toContain(getRawMessages(locale)['signup.freeToStartNoCreditCard']);
  });
});
