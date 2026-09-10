import { NextResponse } from 'next/server';
import { localeForAcceptLanguage } from '@/lib/i18n/locales';
import { getMessages, translate } from '@/lib/i18n/messages';
import { getTranslations } from '@/lib/i18n/server';
import { extractBearerToken } from '@/lib/supabase/bearer';

type Translator = Awaited<ReturnType<typeof getTranslations>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Native clients send their selected language explicitly; browser cookies keep their existing precedence. */
export async function getAIRequestTranslations(req: Request): Promise<Translator> {
  const locale = extractBearerToken(req.headers.get('authorization'))
    ? localeForAcceptLanguage(req.headers.get('accept-language'))
    : null;
  if (!locale) return getTranslations();
  const messages = getMessages(locale.code);
  return (key, params) => translate(messages, key, params);
}

/** The header asserts the authenticated scope; it never selects another household. */
export function assertAIRequestFamily(req: Request, familyId: string, t: Translator): NextResponse | null {
  const expected = req.headers.get('x-bubaly-family-id');
  if (expected === null) return null;
  if (!UUID.test(expected)) {
    return NextResponse.json({ error: t('assistantContext.invalidFamily'), code: 'invalid_family' }, { status: 400 });
  }
  if (expected.toLowerCase() !== familyId.toLowerCase()) {
    return NextResponse.json({ error: t('assistantContext.familyChanged'), code: 'family_changed' }, { status: 409 });
  }
  return null;
}
