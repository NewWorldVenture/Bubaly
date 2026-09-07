// Kitchen Mode — "a shared family screen on the tablet you already own".
//
// The tablet on the right is CSS only, composed from the real default layout
// (lib/display/tiles.ts DEFAULT_TILES): no raster asset, nothing to load, and
// the mock cannot drift from what /display actually shows by default. The
// copy claims only what lib/display and components/display contain — widgets
// a family arranges, kitchen timers, weather, a photo frame, full-screen via
// Add to Home Screen. No PIN lock, voice control, burn-in protection or
// certified hardware: none of those exist in the product today.
import {
  Calendar, CheckCircle2, CloudSun, Image as ImageIcon, ShoppingCart, Sparkles, Timer, Users, UtensilsCrossed, Check, type LucideIcon,
} from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { BandHeader, Container, PrimaryLink, SampleBadge } from '@/components/marketing/visual-mocks';
import { DEFAULT_TILES, type TileSize, type TileWidget } from '@/lib/display/tiles';
import { cn } from '@/lib/utils/cn';

const WIDGET_ICON: Partial<Record<TileWidget, LucideIcon>> = {
  featured: ImageIcon,
  schedule: Calendar,
  timers: Timer,
  weather: CloudSun,
  meals: UtensilsCrossed,
  chores: CheckCircle2,
  grocery: ShoppingCart,
  calendar: Calendar,
  members: Users,
};

/** Catalogue keys for the short label each mock tile shows. */
const WIDGET_LABEL_KEY: Partial<Record<TileWidget, string>> = {
  featured: 'kitchenMode.tileFeatured',
  schedule: 'kitchenMode.tileSchedule',
  timers: 'kitchenMode.tileTimers',
  weather: 'kitchenMode.tileWeather',
  meals: 'kitchenMode.tileMeals',
  chores: 'kitchenMode.tileChores',
  grocery: 'kitchenMode.tileGrocery',
  calendar: 'kitchenMode.tileCalendar',
  members: 'kitchenMode.tileMembers',
};

// Four columns, five rows. The default layout (hero, md, md, sm×4, md, wide)
// fills the grid exactly with these spans.
const SIZE_CLASS: Record<TileSize, string> = {
  hero: 'col-span-2 row-span-2',
  md: 'col-span-1 row-span-2',
  lg: 'col-span-2 row-span-2',
  sm: 'col-span-1 row-span-1',
  wide: 'col-span-3 row-span-2',
};

const BULLETS = ['kitchenMode.bullet1', 'kitchenMode.bullet2', 'kitchenMode.bullet3', 'kitchenMode.bullet4'];

export async function KitchenModeBand() {
  const t = await getTranslations();
  return (
    <Container className="max-w-[1440px] px-5 pb-4 pt-14 sm:px-8 sm:pt-16 lg:px-10">
      <section className="showcase-panel overflow-hidden p-6 sm:p-8 lg:p-10">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
          <div>
            <BandHeader eyebrow={t('kitchenMode.eyebrow')} title={t('kitchenMode.title')} body={t('kitchenMode.body')} />
            <ul className="mt-6 space-y-3 text-sm text-white/86">
              {BULLETS.map((key) => (
                <li key={key} className="flex items-start gap-3">
                  <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
                  {t(key)}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-white/55">{t('kitchenMode.tier')}</p>
            <div className="mt-6">
              <PrimaryLink href="/display">{t('kitchenMode.cta')}</PrimaryLink>
            </div>
          </div>

          <figure className="mx-auto w-full max-w-[520px]">
            <div
              role="img"
              aria-label={t('kitchenMode.mockAlt')}
              className="dark rounded-[28px] border-[6px] border-[rgb(var(--device-bezel))] bg-[#06101a] p-3 shadow-[0_24px_60px_rgba(0,0,0,0.35)]"
            >
              <div aria-hidden className="grid aspect-[4/3] grid-cols-4 grid-rows-5 gap-1.5">
                {DEFAULT_TILES.map((tile) => {
                  const Icon = WIDGET_ICON[tile.widget] ?? Sparkles;
                  const labelKey = WIDGET_LABEL_KEY[tile.widget];
                  const isPhoto = tile.widget === 'featured';
                  return (
                    <div
                      key={tile.id}
                      className={cn(
                        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/[0.08] p-2',
                        isPhoto ? 'bg-gradient-to-br from-violet-500/40 via-blue-500/25 to-emerald-500/30' : 'bg-white/[0.05]',
                        SIZE_CLASS[tile.size],
                      )}
                    >
                      <div className="flex items-center gap-1 text-[9px] font-semibold text-white/80 sm:text-[10px]">
                        <Icon className="h-3 w-3 shrink-0 text-white/70" />
                        {labelKey && <span className="truncate">{t(labelKey)}</span>}
                      </div>
                      {!isPhoto && (
                        <div className="mt-1.5 space-y-1">
                          <span className="block h-1 w-4/5 rounded bg-white/20" />
                          <span className="block h-1 w-3/5 rounded bg-white/15" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <figcaption className="mt-3 flex items-center justify-center gap-2 text-xs text-white/55">
              <SampleBadge>{t('handledProof.sampleBadge')}</SampleBadge>
              {t('kitchenMode.exampleCaption')}
            </figcaption>
          </figure>
        </div>
      </section>
    </Container>
  );
}
