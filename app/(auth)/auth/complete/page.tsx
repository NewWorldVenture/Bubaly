import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CallbackCompletion } from '@/components/auth/callback-completion';
import { resolveAuthSelection } from '@/lib/billing/review-selection';
import { captureCallbackRequestWitness } from '@/lib/auth/callback-witness-server';
import { parseCallbackAdmissionWitness } from '@/lib/auth/callback-witness';

export const metadata: Metadata = { title: 'Complete sign in', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function CallbackCompletionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Start from this request's immutable store before awaiting query admission.
  // A supplied witness never uses this newer snapshot, even if malformed.
  const originalCookies = headers().then(request => ({ cookie: request.get('cookie') })).catch(() => null);
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, item);
  }
  const values = query.getAll('code');
  const code = values.length === 1 && values[0].length > 0 && values[0].length <= 4096
    && !/[\s\x00-\x1f\x7f]/.test(values[0]) && !query.has('error') && !query.has('error_code')
    && !['access_token', 'refresh_token', 'id_token', 'token_hash'].some(name => query.has(name)) ? values[0] : null;
  const next = resolveAuthSelection(query, 'next').next ?? '/home';
  const supplied = query.getAll('admission');
  const captured = supplied.length ? null : await originalCookies;
  const admission = supplied.length === 1 && parseCallbackAdmissionWitness(supplied[0]) ? supplied[0]
    : supplied.length ? null : captured ? captureCallbackRequestWitness(captured.cookie) : null;
  return <CallbackCompletion key={JSON.stringify({ code, next, admission })} code={code} next={next} admission={admission} />;
}
