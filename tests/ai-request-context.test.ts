import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAIRequestTranslations } from '@/lib/server/ai-request-context';

const fallback = vi.hoisted(() => vi.fn(async () => (key: string) => 'cookie-or-geo:' + key));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: fallback }));

beforeEach(() => vi.clearAllMocks());

describe('assistant request locale', () => {
  it.each([
    ['en-US', 'Your active household changed. Return to the assistant and try again.'],
    ['de-DE', 'Ihr aktiver Haushalt hat sich geändert. Kehren Sie zum Assistenten zurück und versuchen Sie es erneut.'],
    ['es-ES', 'Tu hogar activo ha cambiado. Vuelve al asistente e inténtalo de nuevo.'],
    ['fr-FR', 'Votre foyer actif a changé. Revenez à l’assistant et réessayez.'],
    ['it-IT', 'Il tuo nucleo familiare attivo è cambiato. Torna all’assistente e riprova.'],
    ['nl-NL', 'Je actieve huishouden is gewijzigd. Ga terug naar de assistent en probeer het opnieuw.'],
    ['pt-PT', 'O seu agregado familiar ativo mudou. Volte ao assistente e tente novamente.'],
  ])('uses the selected %s catalogue for bearer requests', async (locale, expected) => {
    const t = await getAIRequestTranslations(new Request('http://localhost/api/ai', {
      headers: { authorization: 'Bearer tok', 'Accept-Language': locale, 'x-vercel-ip-country': 'US' },
    }));
    expect(t('assistantContext.familyChanged')).toBe(expected);
    expect(t('assistantContext.invalidFamily')).not.toContain('assistantContext.');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('preserves existing cookie and geo precedence for browser clients', async () => {
    const t = await getAIRequestTranslations(new Request('http://localhost/api/ai', {
      headers: { 'Accept-Language': 'de-DE', 'x-vercel-ip-country': 'US' },
    }));
    expect(t('assistantContext.familyChanged')).toBe('cookie-or-geo:assistantContext.familyChanged');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'zz-ZZ', 'de-DE;q=0'])('falls back when bearer locale %s is unavailable', async (locale) => {
    const t = await getAIRequestTranslations(new Request('http://localhost/api/ai', {
      headers: { authorization: 'Bearer tok', ...(locale ? { 'Accept-Language': locale } : {}) },
    }));
    expect(t('assistantContext.familyChanged')).toBe('cookie-or-geo:assistantContext.familyChanged');
    expect(fallback).toHaveBeenCalledOnce();
  });
});
