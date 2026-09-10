import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateMetadata } from '@/app/onboarding/page';
const request = vi.hoisted(() => ({ locale: 'en-US', reads: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: request.locale }) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: request.reads, createServiceClient: request.reads }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: request.reads }));
vi.mock('@/lib/sync/registry', () => ({ configuredAdapters: request.reads }));
vi.mock('@/components/onboarding/onboarding-wizard', () => ({ OnboardingWizard: () => null }));
afterEach(() => request.reads.mockClear());
describe('request-localized onboarding metadata', () => {
  it.each([
    ['en-US', 'Create your profile'], ['de-DE', 'Erstellen Sie Ihr Profil'], ['es-ES', 'Crea tu perfil'],
    ['fr-FR', 'Créez votre profil'], ['it-IT', 'Crea il tuo profilo'], ['nl-NL', 'Maak je profiel aan'], ['pt-PT', 'Crie o seu perfil'],
  ])('uses the current %s request locale without reading account or provider data', async (locale, title) => {
    request.locale = locale;
    expect(await generateMetadata()).toEqual({ title });
    expect(request.reads).not.toHaveBeenCalled();
  });
  it('does not reuse metadata from an earlier request locale', async () => {
    request.locale = 'fr-FR'; expect(await generateMetadata()).toEqual({ title: 'Créez votre profil' });
    request.locale = 'de-DE'; expect(await generateMetadata()).toEqual({ title: 'Erstellen Sie Ihr Profil' });
  });
});
