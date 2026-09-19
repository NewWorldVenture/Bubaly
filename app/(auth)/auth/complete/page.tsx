import type { Metadata } from 'next';
import { CallbackCompletion } from '@/components/auth/callback-completion';
import { resolveAuthSelection } from '@/lib/billing/review-selection';

export const metadata: Metadata = { title: 'Complete sign in', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function CallbackCompletionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, item);
  }
  const values = query.getAll('code');
  const code = values.length === 1 && values[0].length > 0 && values[0].length <= 4096
    && !/[\s\x00-\x1f\x7f]/.test(values[0]) && !query.has('error') && !query.has('error_code')
    && !['access_token', 'refresh_token', 'id_token', 'token_hash'].some(name => query.has(name)) ? values[0] : null;
  const next = resolveAuthSelection(query, 'next').next ?? '/home';
  return <CallbackCompletion key={JSON.stringify({ code, next })} code={code} next={next} />;
}
