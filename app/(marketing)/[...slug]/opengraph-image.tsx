import { ImageResponse } from 'next/og';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables } from '@/lib/supabase/seo-tables';
import { renderPage, hubSlug, type SeoTemplate } from '@/lib/seo/template';

export const runtime = 'nodejs';
export const alt = 'Bubaly';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BRAND = '#7c5dff';
const HUB_VARS = { state: 'the United States', state_abbr: 'US', state_slug: 'us' };

// Resolve the headline + eyebrow for a generated page or its hub.
async function load(slug: string): Promise<{ h1: string; eyebrow: string } | null> {
  const supabase = withSeoTables(createServiceClient());
  const { data: page } = await supabase
    .from('seo_pages').select('template_id, variables').eq('slug', slug).eq('status', 'published').maybeSingle();
  if (page) {
    const { data: tpl } = await supabase
      .from('seo_page_templates').select('*').eq('id', (page as { template_id: string }).template_id).maybeSingle();
    if (tpl && (tpl as { is_active: boolean }).is_active) {
      const r = renderPage(tpl as unknown as SeoTemplate, (page as { variables: Record<string, string> }).variables);
      return { h1: r.h1, eyebrow: r.eyebrow };
    }
  }
  // Hub fallback.
  const { data: templates } = await supabase.from('seo_page_templates').select('*').eq('is_active', true);
  const match = (templates ?? []).find((t: { slug_pattern: string }) => hubSlug(t.slug_pattern) === slug);
  if (match) {
    const r = renderPage(match as unknown as SeoTemplate, HUB_VARS);
    return { h1: r.h1, eyebrow: r.eyebrow };
  }
  return null;
}

export default async function OgImage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const joined = (slug ?? []).join('/');
  const data = await load(joined).catch(() => null);
  const h1 = data?.h1 ?? 'The family app that keeps everyone in sync';
  const eyebrow = data?.eyebrow ?? 'Bubaly';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between', padding: '72px',
          background: `linear-gradient(135deg, #0b0b14 0%, #161427 60%, ${BRAND}22 100%)`,
          color: 'white', fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: BRAND, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 800 }}>B</div>
          <span style={{ fontSize: 30, fontWeight: 700 }}>Bubaly</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {eyebrow && (
            <span style={{ display: 'flex', alignSelf: 'flex-start', border: `1px solid ${BRAND}88`, color: '#c9bfff', background: `${BRAND}22`, borderRadius: 999, padding: '8px 18px', fontSize: 24, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
              {eyebrow}
            </span>
          )}
          <span style={{ fontSize: h1.length > 60 ? 60 : 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: -1.5, maxWidth: 1000 }}>
            {h1}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 26, color: '#9aa0b4' }}>
          <span>bubaly.com</span>
          <span style={{ color: 'white', fontWeight: 600 }}>Get started free →</span>
        </div>
      </div>
    ),
    size,
  );
}
