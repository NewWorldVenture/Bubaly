// "Switching is the easy part" — everything named here ships today:
// one-file imports (lib/migrate/competitors.ts + components/migrate/migrate-wizard.tsx,
// .ics/.csv parsed in the browser by lib/migrate/parse.ts), Smart Imports
// (app/api/ai/flyer), and two-way calendar sync (lib/sync/providers).
//
// Deliberately NOT claimed: a no-setup promise (setup is minutes), duplicate
// merging, entity resolution, inbound email forwarding, importing photos,
// documents or chore history.
// `compact` is the /pricing variant: the three columns and the privacy line,
// without the band chrome and the wizard strip.
import Link from 'next/link';
import { Import, RefreshCw, ScanLine, ShieldCheck, type LucideIcon } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { BandHeader, Container } from '@/components/marketing/visual-mocks';
import { COMPETITORS } from '@/lib/migrate/competitors';
import { cn } from '@/lib/utils/cn';

const COLUMNS: { icon: LucideIcon; titleKey: string; bodyKey: string; competitors?: boolean }[] = [
  { icon: Import, titleKey: 'switching.importTitle', bodyKey: 'switching.importBody', competitors: true },
  { icon: ScanLine, titleKey: 'switching.smartImportsTitle', bodyKey: 'switching.smartImportsBody' },
  { icon: RefreshCw, titleKey: 'switching.syncTitle', bodyKey: 'switching.syncBody' },
];

const STEPS = ['switching.step1', 'switching.step2', 'switching.step3'];

export async function SwitchingBand({ compact = false }: { compact?: boolean }) {
  const t = await getTranslations();

  const columns = (
    <div className="grid gap-4 sm:grid-cols-3">
      {COLUMNS.map(({ icon: Icon, titleKey, bodyKey, competitors }) => (
        <article key={titleKey} className="showcase-card p-5">
          <Icon className="h-5 w-5 text-violet-300" aria-hidden />
          <h3 className="mt-3 text-base font-semibold">{t(titleKey)}</h3>
          <p className="mt-2 text-sm leading-6 text-white/65">{t(bodyKey)}</p>
          {competitors && (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {COMPETITORS.map((c) => (
                <li key={c.key} className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.045] px-2.5 py-1 text-[11px] font-medium text-white/80">
                  {c.name}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );

  const privacy = (
    <p className="flex items-start gap-2 text-xs leading-5 text-white/60">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
      {t('switching.privacyLine')}
    </p>
  );

  if (compact) {
    return (
      <section aria-label={t('switching.title')} className="space-y-4">
        {columns}
        {privacy}
      </section>
    );
  }

  return (
    <Container className="max-w-[1440px] px-5 pb-4 pt-14 sm:px-8 sm:pt-16 lg:px-10">
      <BandHeader eyebrow={t('switching.eyebrow')} title={t('switching.title')} body={t('switching.body')} />
      <div className={cn('mt-8')}>{columns}</div>

      <ol className="mt-6 grid gap-3 sm:grid-cols-3">
        {STEPS.map((key, index) => (
          <li key={key} className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 text-sm text-white/85">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-violet-500/15 text-xs font-bold text-white/90 ring-1 ring-violet-400/30">{index + 1}</span>
            {t(key)}
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        {privacy}
        <Link href="/signup" className="focus-visible:focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-500 to-violet-600 px-7 text-sm font-semibold text-brand-fg shadow-glow transition hover:-translate-y-0.5 hover:brightness-110">
          {t('switching.cta')}
        </Link>
      </div>
    </Container>
  );
}
