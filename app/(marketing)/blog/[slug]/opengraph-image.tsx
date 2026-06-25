import { ImageResponse } from 'next/og';
import { getPost, type BlogCategory } from '@/lib/blog/posts';

export const runtime = 'edge';
export const alt = 'Bubaly Blog';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const CATEGORY_COLORS: Record<BlogCategory, string> = {
  'Parenting': '#8b5cf6',
  'Organization': '#3b82f6',
  'School & Activities': '#10b981',
  'AI & Technology': '#6366f1',
  'Wellness': '#f59e0b',
  'Family Finances': '#f43f5e',
};

export default async function OGImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPost(slug);

  const title = post?.title ?? 'Bubaly Blog';
  const category = post?.category ?? 'Parenting';
  const author = post?.author ?? 'Bubaly Team';
  const accent = CATEGORY_COLORS[category as BlogCategory] ?? '#8b5cf6';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '60px 72px',
          background: `linear-gradient(135deg, #050a12 0%, #0d1526 50%, ${accent}22 100%)`,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '12px',
              background: `linear-gradient(135deg, #3b82f6, #8b5cf6)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: '24px', color: 'white', fontWeight: 800 }}>B</span>
          </div>
          <span style={{ fontSize: '28px', fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
            Bubaly Blog
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <div
              style={{
                padding: '6px 16px',
                borderRadius: '20px',
                background: `${accent}33`,
                border: `1px solid ${accent}55`,
                fontSize: '16px',
                fontWeight: 600,
                color: accent,
              }}
            >
              {category}
            </div>
          </div>
          <div
            style={{
              fontSize: title.length > 60 ? '42px' : '52px',
              fontWeight: 800,
              color: 'white',
              lineHeight: 1.15,
              maxWidth: '900px',
            }}
          >
            {title}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.6)' }}>By {author}</span>
          <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.3)' }}>•</span>
          <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.6)' }}>bubaly.com</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
