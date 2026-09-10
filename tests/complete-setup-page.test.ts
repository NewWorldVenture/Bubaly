import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompleteSetupPage, { generateMetadata } from '@/app/(app)/dashboard/setup/page';
import { CompleteSetupForm } from '@/components/onboarding/complete-setup';
import { computeCompleteness, type CompletenessSignals } from '@/lib/onboarding/completeness';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const state = vi.hoisted(() => ({ locale: 'en-US' as LocaleCode, context: vi.fn(), client: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), read: vi.fn(), resolve: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: state.locale }) }), headers: async () => new Headers() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: state.context }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: state.client }));
vi.mock('@/lib/server/onboarding-progress', () => ({ resolveCompleteness: state.resolve }));
vi.mock('@/components/onboarding/complete-setup', () => ({ CompleteSetupForm: () => null }));

const userId = '11111111-1111-4111-8111-111111111111';
const familyId = '22222222-2222-4222-8222-222222222222';
const unfinished: CompletenessSignals = { hasName: false, hasFamily: true, hasQuestionnaire: false, hasGoals: false, valueEngaged: false, memberCount: 0, hasPin: false, source: 'auto_provision', status: 'in_progress' };
const complete: CompletenessSignals = { hasName: true, hasFamily: true, hasQuestionnaire: true, hasGoals: true, valueEngaged: true, memberCount: 2, hasPin: true, source: 'wizard', status: 'completed' };
const row = { household_adults: 2, household_children: 2, child_ages: [8, 12], goals: ['calendar', 'budget'], referral_source: 'search' };
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : []; }
const t = (key: string) => translate(getMessages(state.locale), key);

beforeEach(() => {
  state.locale = 'en-US'; for (const mock of [state.context, state.client, state.from, state.select, state.eq, state.read, state.resolve]) mock.mockReset();
  state.context.mockResolvedValue({ user: { id: userId }, active: { familyId, family: { name: 'North household' } } });
  const db = { from: state.from }; state.client.mockReturnValue(db); state.from.mockReturnValue({ select: state.select });
  state.select.mockReturnValue({ eq: state.eq }); state.eq.mockReturnValue({ maybeSingle: state.read }); state.read.mockResolvedValue({ data: row });
  state.resolve.mockResolvedValue({ result: computeCompleteness(unfinished), progress: { source: 'auto_provision' } });
});

describe('existing-family setup page localization boundary', () => {
  it.each([
    ['en-US', 'Complete your setup'], ['de-DE', 'Schließen Sie Ihre Einrichtung ab'], ['es-ES', 'Completa tu configuración'],
    ['fr-FR', 'Terminez votre configuration'], ['it-IT', 'Completa la configurazione'], ['nl-NL', 'Rond je instellingen af'], ['pt-PT', 'Conclua a sua configuração'],
  ] as const)('%s resolves request-localized metadata without reading account data', async (locale, title) => {
    state.locale = locale; expect(await generateMetadata()).toEqual({ title });
    expect(state.context).not.toHaveBeenCalled(); expect(state.client).not.toHaveBeenCalled(); expect(state.resolve).not.toHaveBeenCalled();
  });

  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('%s translates missing pieces while preserving their order, targets and existing-family prefill', async locale => {
    state.locale = locale; const result = computeCompleteness(unfinished); const before = structuredClone(result);
    state.resolve.mockResolvedValue({ result, progress: { source: 'auto_provision' } });
    const tree = await CompleteSetupPage(); const html = renderToStaticMarkup(tree);
    expect(html).toContain(t('completeSetupCopy.headlineNeedsSetup')); expect(html).toContain(t('completeSetupCopy.missingQuestionnaire'));
    expect(html).toContain(t('onboardingCopy.aboutTitle'));
    const links = nodes(tree).filter(node => node.props.href);
    expect(links.map(node => node.props.href)).toEqual(result.missing.map(piece => piece.href));
    const form = nodes(tree).find(node => node.type === CompleteSetupForm)!;
    expect(form.props).toEqual({ familyId, initial: { adults: 2, children: 2, childAges: [8, 12], goals: ['calendar', 'budget'], referralSource: 'search' } });
    expect(state.eq).toHaveBeenCalledExactlyOnceWith('family_id', familyId); expect(result).toEqual(before);
  });

  it.each([
    ['complete', complete, 'completeSetupCopy.headlineComplete'],
    ['reset', { ...complete, status: 'reset' }, 'completeSetupCopy.headlineReset'],
    ['remaining', { ...unfinished, source: 'wizard', status: 'completed' }, 'completeSetupCopy.headlineRemaining'],
  ] as const)('renders the %s cohort without changing the computed status or score', async (_cohort, signals, titleKey) => {
    state.locale = 'de-DE'; const result = computeCompleteness(signals); const before = structuredClone(result);
    state.resolve.mockResolvedValue({ result, progress: { source: signals.source } });
    const html = renderToStaticMarkup(await CompleteSetupPage());
    expect(html).toContain(t(titleKey)); expect(html).toContain(`${result.score}%`); expect(result).toEqual(before);
  });

  it('keeps the authenticated page guard ahead of privileged completeness and prefill reads', async () => {
    const redirect = new Error('NEXT_REDIRECT'); state.context.mockRejectedValueOnce(redirect);
    await expect(CompleteSetupPage()).rejects.toBe(redirect);
    expect(state.client).not.toHaveBeenCalled(); expect(state.resolve).not.toHaveBeenCalled(); expect(state.from).not.toHaveBeenCalled();
  });

  it('keeps an unknown future missing-piece label and destination usable', async () => {
    const result = computeCompleteness(complete); result.missing.push({ key: 'future', label: 'New setup task', href: '/dashboard/setup?future=1', weight: 0 });
    state.resolve.mockResolvedValue({ result, progress: null });
    const html = renderToStaticMarkup(await CompleteSetupPage()); expect(html).toContain('New setup task'); expect(html).toContain('/dashboard/setup?future=1');
  });
});
