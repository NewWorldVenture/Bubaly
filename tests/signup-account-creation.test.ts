import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUpSchema, signInSchema, fieldErrors } from '@/lib/validation';

// Creating an account, end to end, at the two places it can actually go wrong
// before onboarding takes over (onboarding itself has 26 test files already):
//
//   1. signUpSchema — the gate every new account passes through, and which had
//      no test of any kind. A loosened rule here reaches production silently.
//   2. The submit path in SignupForm — what happens on success, on an
//      unconfirmed account, on a DUPLICATE EMAIL, and on a provider error.
//
// The duplicate-email case is the one worth the most care. Supabase answers a
// signup for an existing confirmed address with a user, no session, and an
// empty identities array — deliberately indistinguishable from a genuine new
// signup, so an attacker cannot enumerate who has an account. The form's
// `if (!data.session) setCheckEmail(true)` inherits that property by accident
// of structure rather than by intent, and the obvious "helpful" change —
// telling the user the address is already registered — would quietly reintroduce
// enumeration. Pinned here so that change has to be deliberate.

describe('signUpSchema — the gate every new account passes', () => {
  const valid = { fullName: 'Taylor Example', email: 'taylor@example.test', password: 'correct-horse' };

  it('accepts a well-formed signup', () => {
    expect(signUpSchema.safeParse(valid).success).toBe(true);
  });

  it('normalises the email, so signup and login agree on identity', () => {
    const parsed = signUpSchema.parse({ ...valid, email: '  Taylor@Example.TEST  ' });
    expect(parsed.email).toBe('taylor@example.test');
    // The same normalisation on the login side. If these ever diverge, a person
    // who signed up as "Taylor@" simply cannot sign in again, and the failure
    // looks like a wrong password rather than a bug.
    expect(signInSchema.parse({ email: '  Taylor@Example.TEST  ', password: 'x' }).email).toBe('taylor@example.test');
  });

  it('trims the name but never the password', () => {
    expect(signUpSchema.parse({ ...valid, fullName: '  Taylor Example  ' }).fullName).toBe('Taylor Example');
    // Trimming a password would silently change the credential between signup
    // and login, and would reject legitimate leading/trailing spaces.
    expect(signUpSchema.parse({ ...valid, password: ' spaced pass ' }).password).toBe(' spaced pass ');
  });

  it.each([
    ['empty name', { fullName: '' }],
    ['one-character name', { fullName: 'T' }],
    ['name over 120', { fullName: 'x'.repeat(121) }],
    ['missing @', { email: 'not-an-email' }],
    ['empty email', { email: '' }],
    ['password under 8', { password: 'short12' }],
    ['empty password', { password: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(signUpSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('accepts exactly 8 characters and rejects 7 — the boundary, both sides', () => {
    expect(signUpSchema.safeParse({ ...valid, password: 'x'.repeat(8) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...valid, password: 'x'.repeat(7) }).success).toBe(false);
  });

  it('caps the password at 72 bytes, which is bcrypt’s limit', () => {
    // Past 72 bytes bcrypt silently ignores the remainder, so two different
    // long passwords would authenticate the same account. Rejecting is right.
    expect(signUpSchema.safeParse({ ...valid, password: 'x'.repeat(72) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...valid, password: 'x'.repeat(73) }).success).toBe(false);
  });

  it('reports errors per field, so the form can mark the right input', () => {
    const parsed = signUpSchema.safeParse({ fullName: '', email: 'nope', password: '1' });
    expect(parsed.success).toBe(false);
    const errors = fieldErrors(parsed.error!);
    expect(Object.keys(errors).sort()).toEqual(['email', 'fullName', 'password']);
    for (const message of Object.values(errors)) expect(message.length).toBeGreaterThan(0);
  });
});

// ── The submit path ────────────────────────────────────────────────────────
// Same hook-stubbing harness as auth-review-selection-forms.test.ts, which
// renders these forms for the plan-selection concern. This exercises the part
// that file does not: what account creation does with each answer it can get.

const mock = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[],
  query: new URLSearchParams(),
  push: vi.fn(), refresh: vi.fn(), toast: vi.fn(), stitch: vi.fn(), referral: vi.fn(),
  signUp: vi.fn(), password: vi.fn(), oauth: vi.fn(), otp: vi.fn(), verify: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.slots)) mock.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [mock.slots[index], (value: unknown) => {
      mock.slots[index] = typeof value === 'function' ? (value as (p: unknown) => unknown)(mock.slots[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.slots)) mock.slots[index] = { current: initial };
    return mock.slots[index];
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[] = []) => {
    const index = mock.cursor++;
    const previous = mock.slots[index] as readonly unknown[] | undefined;
    if (previous && deps.every((item, i) => Object.is(item, previous[i]))) return;
    mock.slots[index] = deps;
    mock.effects.push(() => { const cleanup = effect(); if (typeof cleanup === 'function') mock.cleanups.push(cleanup); });
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mock.push, refresh: mock.refresh }), useSearchParams: () => mock.query }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: ReactNode }) => ({ type: 'a', props: { ...props, children }, $$typeof: Symbol.for('react.element') }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: mock.toast, success: mock.toast }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { getMessages } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string) => getMessages('en-US')[key] ?? key };
});
vi.mock('@/components/auth/legal-consent', () => ({ LegalConsent: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: {
  signUp: mock.signUp, signInWithPassword: mock.password, signInWithOAuth: mock.oauth,
  signInWithOtp: mock.otp, verifyOtp: mock.verify,
} }) }));
vi.mock('@/app/(auth)/actions', () => ({ resolveLandingPathAction: vi.fn(), stitchIdentityAction: mock.stitch }));
vi.mock('@/app/(auth)/signup/actions', () => ({ rememberReferralCodeAction: mock.referral }));

const { SignupForm } = await import('@/components/auth/signup-form');
const { getMessages } = await import('@/lib/i18n/messages');

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
function resetHooks() { mock.cleanups.splice(0).forEach((c) => c()); mock.slots = []; mock.effects = []; }
function click(tree: ReactNode, label: string) {
  const target = nodes(tree).find((n) => typeof n.props.onClick === 'function' && textOf(n.props.children as ReactNode).trim() === label);
  expect(target, `Missing button ${label}`).toBeDefined();
  return (target!.props.onClick as () => unknown)();
}
async function submitWith(fields: { fullName: string; email: string; password: string }) {
  let tree = render(() => SignupForm());
  click(tree, getMessages('en-US')['signup.continueWithEmail']);
  tree = render(() => SignupForm());
  const form = nodes(tree).find((n) => n.type === 'form');
  expect(form, 'email form did not render').toBeDefined();
  await (form!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: fields });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  return render(() => SignupForm());
}
const GOOD = { fullName: 'Taylor Example', email: 'taylor@example.test', password: 'correct-horse' };

beforeEach(() => {
  resetHooks(); vi.clearAllMocks();
  mock.query = new URLSearchParams();
  mock.signUp.mockReset().mockResolvedValue({ data: { session: { user: { id: 'u1' } }, user: { id: 'u1' } }, error: null });
  vi.stubGlobal('window', { location: { origin: 'https://bubaly.test' } });
  vi.stubGlobal('FormData', class { constructor(private f: Record<string, string>) {} get(n: string) { return this.f[n]; } });
});
afterEach(() => { resetHooks(); vi.unstubAllGlobals(); });

describe('SignupForm — creating the account', () => {
  it('sends the normalised email and the name to Supabase, and routes on success', async () => {
    await submitWith({ ...GOOD, email: '  Taylor@Example.TEST  ' });

    expect(mock.signUp).toHaveBeenCalledTimes(1);
    const arg = mock.signUp.mock.calls[0][0];
    expect(arg.email).toBe('taylor@example.test');
    expect(arg.password).toBe(GOOD.password);
    expect(arg.options.data.full_name).toBe('Taylor Example');
    // The confirmation link must return to THIS origin's callback, carrying the
    // destination; a wrong origin here sends new users to another deployment.
    expect(arg.options.emailRedirectTo).toBe('https://bubaly.test/auth/callback?next=%2Fonboarding');
    expect(mock.push).toHaveBeenCalledWith('/onboarding');
  });

  it('shows "check your email" and does NOT route when confirmation is required', async () => {
    mock.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u1', identities: [{ id: 'i1' }] } }, error: null });

    const tree = await submitWith(GOOD);
    expect(textOf(tree)).toContain(getMessages('en-US')['signup.checkEmailTitle']);
    expect(mock.push).not.toHaveBeenCalled();
  });

  // The anti-enumeration property, stated as a test so removing it is deliberate.
  it('treats an ALREADY-REGISTERED email exactly like a new one', async () => {
    // What Supabase returns for an existing confirmed address: a user, no
    // session, and no identities.
    mock.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u1', identities: [] } }, error: null });

    const tree = await submitWith(GOOD);
    const text = textOf(tree);
    expect(text).toContain(getMessages('en-US')['signup.checkEmailTitle']);
    // Nothing on screen may reveal that the address is taken.
    expect(text.toLowerCase()).not.toContain('already');
    expect(text.toLowerCase()).not.toContain('exists');
    expect(text.toLowerCase()).not.toContain('registered');
    expect(text.toLowerCase()).not.toContain('taken');
    expect(mock.toast).not.toHaveBeenCalled();
    expect(mock.push).not.toHaveBeenCalled();
  });

  it('never calls Supabase when the input fails validation', async () => {
    await submitWith({ fullName: '', email: 'not-an-email', password: '1' });
    expect(mock.signUp).not.toHaveBeenCalled();
    expect(mock.push).not.toHaveBeenCalled();
  });

  it('surfaces a provider failure as a toast and stays on the form', async () => {
    mock.signUp.mockResolvedValue({ data: { session: null }, error: { message: 'Signup is disabled' } });

    const tree = await submitWith(GOOD);
    expect(mock.toast).toHaveBeenCalledTimes(1);
    expect(mock.push).not.toHaveBeenCalled();
    // Still the form, not the check-your-email screen.
    expect(textOf(tree)).not.toContain(getMessages('en-US')['signup.checkEmailTitle']);
  });

  it('recovers from a thrown network error without routing', async () => {
    mock.signUp.mockRejectedValue(new Error('fetch failed'));

    await submitWith(GOOD);
    expect(mock.toast).toHaveBeenCalledTimes(1);
    expect(mock.push).not.toHaveBeenCalled();
  });

  it('carries a ?ref= code into the auth metadata and remembers it server-side', async () => {
    mock.query = new URLSearchParams('ref=ABC12345');

    await submitWith(GOOD);
    expect(mock.referral).toHaveBeenCalled();
    expect(mock.signUp.mock.calls[0][0].options.data.referral_code).toBeTruthy();
  });

  it('sends no referral_code when there is no ref', async () => {
    await submitWith(GOOD);
    expect(mock.signUp.mock.calls[0][0].options.data).not.toHaveProperty('referral_code');
  });
});
