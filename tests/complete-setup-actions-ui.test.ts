import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompleteSetupForm } from '@/components/onboarding/complete-setup';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, locale: 'en-US' as LocaleCode,
  save: vi.fn(), reset: vi.fn(), error: vi.fn(), success: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }];
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, refresh: state.refresh }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: state.error, success: state.success }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(state.locale), key, params) };
});
vi.mock('@/app/onboarding/actions', () => ({ saveFamilyDetailsAction: state.save, resetOnboardingAction: state.reset }));
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === 'function' && node.type.name === 'Stepper') return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...nodes(node.props.children as ReactNode)];
}
function text(node: ReactNode): string { return Array.isArray(node) ? node.map(text).join('') : isValidElement<{children?:ReactNode}>(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
const familyId = '22222222-2222-4222-8222-222222222222';
const initial = { adults: 2, children: 2, childAges: [8, 12], goals: ['calendar', 'chores'], referralSource: 'ad' };
const t = (key: string, params?: Record<string, string | number>) => translate(getMessages(state.locale), key, params);
function render() { state.cursor = 0; return CompleteSetupForm({ familyId, initial }); }
function button(tree: ReactNode, key: string) {
  const control = nodes(tree).find(node => typeof node.props.onClick === 'function' && text(node).trim() === t(key));
  if (!control) throw new Error(`Missing ${key}`);
  return control;
}
beforeEach(() => {
  state.slots = []; state.cursor = 0; state.locale = 'en-US';
  for (const mock of [state.save, state.reset, state.error, state.success, state.push, state.refresh]) mock.mockReset();
  state.save.mockResolvedValue({ ok: true }); state.reset.mockResolvedValue({ ok: true });
});

describe('localized existing-family setup actions', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('%s keeps option IDs and the existing family payload across a failed save and retry', async locale => {
    state.locale = locale;
    const tree = render();
    expect(state.save).not.toHaveBeenCalled(); expect(state.reset).not.toHaveBeenCalled();
    expect(text(tree)).toContain(t('onboardingCopy.adultCountOther', { count: 2 }));
    expect(text(tree)).toContain(t('onboardingCopy.goalCalendar'));
    const referral = nodes(tree).find(node => node.type === 'select')!;
    expect(referral.props.value).toBe('ad');
    expect(nodes(referral).find(node => node.type === 'option' && node.props.value === 'ad')?.props.children).toBe(t('onboardingCopy.referralAd'));
    state.save.mockResolvedValueOnce({ ok: false });
    await (button(tree, 'completeSetup.saveMySetup').props.onClick as () => Promise<void>)();
    expect(state.error).toHaveBeenCalledExactlyOnceWith(t('completeSetupCopy.saveError'));
    expect(state.push).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
    await (button(render(), 'completeSetup.saveMySetup').props.onClick as () => Promise<void>)();
    const expected = { familyId, householdAdults: 2, householdChildren: 2, childAges: [8, 12], goals: ['calendar', 'chores'], referralSource: 'ad' };
    expect(state.save.mock.calls).toEqual([[expected], [expected]]);
    expect(state.success).toHaveBeenCalledExactlyOnceWith(t('completeSetup.setupSavedYourFamilyProfile'));
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/dashboard'); expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['de-DE', 'fr-FR', 'pt-PT'] as const)('%s reset retains form state and preserves the no-argument action and refresh contract', async locale => {
    state.locale = locale; state.reset.mockResolvedValueOnce({ ok: false });
    await (button(render(), 'completeSetup.resetOnboarding').props.onClick as () => Promise<void>)();
    expect(state.error).toHaveBeenCalledExactlyOnceWith(t('completeSetupCopy.resetError'));
    expect(state.refresh).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
    await (button(render(), 'completeSetup.resetOnboarding').props.onClick as () => Promise<void>)();
    expect(state.reset.mock.calls).toEqual([[], []]); expect(state.refresh).toHaveBeenCalledTimes(1); expect(state.push).not.toHaveBeenCalled();
    const tree = render(); expect(text(tree)).toContain(t('onboardingCopy.childCountOther', { count: 2 }));
    expect(nodes(tree).find(node => node.type === 'select')?.props.value).toBe('ad');
  });

  it('translated counter and age controls keep numeric clamping and submitted age filtering', async () => {
    state.locale = 'de-DE'; let tree = render();
    const more = nodes(tree).find(node => node.props['aria-label'] === t('onboardingCopy.more', { label: t('completeSetup.kids') }))!;
    (more.props.onClick as () => void)(); tree = render();
    const age = nodes(tree).find(node => node.props['aria-label'] === t('onboardingCopy.childAge', { number: 3 }))!;
    (age.props.onChange as (event: {target:{value:string}}) => void)({ target: { value: '99 years' } });
    await (button(render(), 'completeSetup.saveMySetup').props.onClick as () => Promise<void>)();
    expect(state.save.mock.calls[0][0]).toMatchObject({ householdChildren: 3, childAges: [8, 12, 21] });
  });

  it('the pending save control remains disabled until its existing action completes', async () => {
    let resolve: (value: unknown) => void = () => {};
    state.save.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = (button(render(), 'completeSetup.saveMySetup').props.onClick as () => Promise<void>)();
    expect(button(render(), 'completeSetup.saveMySetup').props.disabled).toBe(true);
    resolve({ ok: false, error: 'Provider supplied error' }); await pending;
    expect(button(render(), 'completeSetup.saveMySetup').props.disabled).toBe(false);
    expect(state.error).toHaveBeenCalledExactlyOnceWith('Provider supplied error'); expect(state.push).not.toHaveBeenCalled();
  });
});
