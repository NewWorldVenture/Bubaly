import type { Metadata } from 'next';
import { Speaker, ShieldCheck } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';
import { NewAssistantKey, RevokeAssistantKey } from './controls';

export const metadata: Metadata = { title: 'Assistants' };
export const dynamic = 'force-dynamic';

type LinkRow = {
  id: string; label: string; provider: string; token_prefix: string;
  scopes: string[] | null; last_used_at: string | null; revoked_at: string | null; created_at: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  alexa: 'Amazon Alexa', siri: 'Siri / Shortcuts', google: 'Google Assistant', generic: 'Other',
};

export default async function AssistantsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // token_hash is deliberately absent: migration 0283 withholds that column
  // from `authenticated` with a column-level grant, so it cannot be selected
  // here even by mistake.
  const { data, error } = await supabase
    .from('assistant_links')
    .select('id, label, provider, token_prefix, scopes, last_used_at, revoked_at, created_at')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false });
  if (error) {
    // Same reason as the library page: 0283 is applied by a person and the
    // sidebar entry ships with the deploy, so "refresh and try again" would be
    // advice that cannot work. Name the migration instead.
    if (isMissingRelationError(error)) {
      return (
        <EmptyState
          icon={Speaker}
          title={t('assistantsPage.notSwitchedOnTitle')}
          description={t('assistantsPage.notSwitchedOnDesc')}
        />
      );
    }
    console.error('[assistants] list read failed', error);
    return <ErrorState message={t('assistantsPage.readError')} />;
  }
  const links = (data ?? []) as unknown as LinkRow[];
  const live = links.filter((link) => !link.revoked_at);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('assistantsPage.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('assistantsPage.intro')}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {links.length === 0 ? (
            <EmptyState icon={Speaker} title={t('assistantsPage.noneConnectedTitle')}
              description={t('assistantsPage.noneConnectedDesc')} />
          ) : links.map((link) => (
            <Card key={link.id} className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{link.label}</p>
                  <p className="text-xs text-muted">
                    {PROVIDER_LABELS[link.provider] ?? link.provider} · {link.token_prefix}…
                  </p>
                </div>
                <Badge tone={link.revoked_at ? 'neutral' : 'success'}>
                  {link.revoked_at ? t('assistantsPage.revoked') : t('assistantsPage.active')}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="neutral">{t('assistantsPage.readsYourDay')}</Badge>
                {(link.scopes ?? []).includes('capture')
                  ? <Badge tone="brand">{t('assistantsPage.canAddThings')}</Badge>
                  : <Badge tone="neutral">{t('assistantsPage.readOnly')}</Badge>}
              </div>
              <p className="text-xs text-muted">
                {link.last_used_at ? t('assistantsPage.lastUsed', { date: fmtDate(link.last_used_at) }) : t('assistantsPage.notUsedYet')}
                {' · '}{t('assistantsPage.added', { date: fmtDate(link.created_at) })}
              </p>
              {!link.revoked_at && <RevokeAssistantKey id={link.id} />}
            </Card>
          ))}

          <Card className="space-y-3">
            <h2 className="font-semibold">{t('assistantsPage.howToConnect')}</h2>
            <div className="space-y-3 text-sm text-muted">
              <div>
                <p className="font-medium text-fg">Siri, on an iPhone or iPad</p>
                <p>
                  Shortcuts app → new shortcut → <strong>Get Contents of URL</strong>.
                  Method <strong>POST</strong>, URL <code className="text-xs">https://www.bubaly.com/api/assistant</code>,
                  a header <code className="text-xs">Authorization: Bearer YOUR-KEY</code>, and a JSON body
                  with one field <code className="text-xs">utterance</code> set to a Dictated Text input.
                  Name the shortcut &ldquo;Ask Bubaly&rdquo; and Siri will run it by name.
                </p>
              </div>
              <div>
                <p className="font-medium text-fg">Alexa</p>
                <p>
                  Point a custom skill&apos;s endpoint at
                  {' '}<code className="text-xs">https://www.bubaly.com/api/assistant/alexa</code> and put the key in
                  account linking. One intent with an <code className="text-xs">AMAZON.SearchQuery</code> slot is enough &mdash;
                  Bubaly works out what you meant from the words.
                </p>
                <p className="mt-1">
                  Bubaly checks Amazon&apos;s request signature on every call, so the endpoint only answers
                  Alexa. Set <code className="text-xs">ALEXA_SKILL_ID</code> to your skill&apos;s application id as
                  well, and it will only answer <em>your</em> skill.
                </p>
              </div>
              <div>
                <p className="font-medium text-fg">Anything else</p>
                <p>
                  Google Assistant, Home Assistant, a Raspberry Pi, a shell script: POST
                  {' '}<code className="text-xs">{'{ "utterance": "what\'s on today" }'}</code> to
                  {' '}<code className="text-xs">/api/assistant</code> with the key as a bearer token.
                </p>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="h-fit">
            <h2 className="mb-3 font-semibold">{t('assistantsPage.newKey')}</h2>
            <NewAssistantKey />
          </Card>

          <Card className="space-y-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
              <h2 className="font-semibold">{t('assistantsPage.whatKeyCanDo')}</h2>
            </div>
            <ul className="space-y-1.5 text-xs text-muted">
              <li>{t('assistantsPage.keyReads')}</li>
              <li>{t('assistantsPage.keyAdds')}</li>
              <li>{t('assistantsPage.keyCannotSee')}</li>
              <li>{t('assistantsPage.keyRecorded')}</li>
              <li>{live.length === 1 ? t('assistantsPage.keyRevokeOne') : t('assistantsPage.keyRevokeMany', { n: live.length })}</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
