import { NextResponse } from 'next/server';
import { parseBuildRevision } from '@/lib/build-identity.mjs';

export const dynamic = 'force-dynamic';

// Keep this direct property access: Next replaces it with the config's build-time
// literal. No runtime hosting variable, request input, or network lookup is used.
const revision = parseBuildRevision(process.env.BUBALY_BUILD_REVISION);

export function GET() {
  return NextResponse.json({ revision }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}
