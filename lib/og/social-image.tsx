import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ImageResponse } from 'next/og';

// Standard Open Graph / Twitter large-image dimensions.
export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = 'image/png';
export const OG_ALT = 'Bubaly — the AI operating system for family life';

// Read the brand wordmark from the filesystem once and inline it as a data URI.
// This keeps the generator fully self-contained (no network fetch at build or
// request time), so social-share previews can never depend on an external host.
function wordmarkDataUri(): string {
  try {
    const file = path.join(process.cwd(), 'public', 'brand', 'bubaly-logo.png');
    const bytes = readFileSync(file);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * Render the shared social preview card used by both `opengraph-image` and
 * `twitter-image`. Dark, brand-gradient background with the Bubaly wordmark and
 * the product tagline — what people see when a bubaly.com link is shared in
 * iMessage, Slack, X, Facebook, etc. Previously these cards were blank because
 * the metadata declared `summary_large_image` with no image.
 */
export function renderSocialImage(): ImageResponse {
  const wordmark = wordmarkDataUri();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#050a12',
          backgroundImage:
            'radial-gradient(900px 600px at 82% -8%, rgba(124,93,255,0.38), transparent 60%), radial-gradient(760px 520px at -6% 112%, rgba(244,153,110,0.22), transparent 58%), linear-gradient(160deg, #0a1120 0%, #050a12 55%, #030911 100%)',
          fontFamily: 'sans-serif',
          position: 'relative',
        }}
      >
        {/* Thin brand accent bar along the top edge */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 8,
            backgroundImage: 'linear-gradient(90deg, #7c5dff 0%, #f4996e 100%)',
          }}
        />

        {wordmark ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wordmark} alt="Bubaly" height={168} style={{ marginBottom: 40 }} />
        ) : (
          <div style={{ display: 'flex', fontSize: 104, fontWeight: 800, color: '#ffffff', marginBottom: 32 }}>
            Bubaly
          </div>
        )}

        <div
          style={{
            display: 'flex',
            fontSize: 60,
            fontWeight: 800,
            color: '#ffffff',
            letterSpacing: -1.5,
            textAlign: 'center',
            lineHeight: 1.1,
            padding: '0 80px',
          }}
        >
          Less Managing Life. More Living It.
        </div>

        <div
          style={{
            display: 'flex',
            marginTop: 28,
            fontSize: 30,
            color: 'rgba(226,224,252,0.72)',
            textAlign: 'center',
            padding: '0 120px',
          }}
        >
          The AI operating system for family life.
        </div>

        <div
          style={{
            display: 'flex',
            position: 'absolute',
            bottom: 44,
            fontSize: 26,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.55)',
            letterSpacing: 2,
          }}
        >
          bubaly.com
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
