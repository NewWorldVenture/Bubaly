import type { Metadata } from 'next';
import { Search, ExternalLink } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { addKeyword } from '../actions';

export const metadata: Metadata = { title: 'Marketing · SEO', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

// The site's real indexable public pages (kept in sync with the marketing site).
const SITE_PAGES = [
  '/', '/features', '/how-it-works', '/ai', '/pricing', '/security', '/faq', '/blog', '/mobile', '/contact',
];
const INTENTS = ['informational', 'navigational', 'commercial', 'transactional'];

export default async function SeoPage() {
  const supabase = createServiceClient();
  const { data: keywords } = await supabase.from('marketing_seo_keywords').select('*').order('created_at', { ascending: false });

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        SEO here uses <strong className="text-fg">first-party data only</strong>. Rankings, search volume, and backlinks are never invented — connect Google Search Console for those. AI keyword ideas are clearly labeled as suggestions.
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <Card>
            <h2 className="mb-3 font-semibold">Indexable pages</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {SITE_PAGES.map((p) => (
                <a key={p} href={p} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:bg-elevated">
                  <span className="font-mono text-xs">{p}</span>
                  <ExternalLink className="h-3.5 w-3.5 text-muted" />
                </a>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <a href="/sitemap.xml" target="_blank" rel="noreferrer" className="rounded-lg border border-border px-3 py-1.5 hover:bg-elevated">View sitemap.xml</a>
              <a href="/robots.txt" target="_blank" rel="noreferrer" className="rounded-lg border border-border px-3 py-1.5 hover:bg-elevated">View robots.txt</a>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Tracked keywords</h2>
            {(keywords ?? []).length === 0 ? (
              <EmptyState icon={Search} title="No keywords tracked" description="Add target keywords on the right." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">Keyword</th><th className="px-3 py-2 font-medium">Intent</th><th className="px-3 py-2 font-medium">Target</th><th className="px-3 py-2 font-medium">Source</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border/60">
                    {(keywords ?? []).map((k) => (
                      <tr key={k.id}>
                        <td className="px-3 py-2 font-medium">{k.keyword}</td>
                        <td className="px-3 py-2 text-muted capitalize">{k.intent ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-muted">{k.target_path ?? '—'}</td>
                        <td className="px-3 py-2">{k.source === 'ai_suggestion' ? <Badge tone="accent">AI idea</Badge> : <Badge tone="neutral">{k.source}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">Track a keyword</h2>
          <form action={addKeyword} className="space-y-3 text-sm">
            <input name="keyword" required placeholder="family organization app" className={inputCls} />
            <select name="intent" className={inputCls}><option value="">Intent (optional)</option>{INTENTS.map((i) => <option key={i} value={i}>{i}</option>)}</select>
            <select name="target_path" className={inputCls}><option value="">Target page (optional)</option>{SITE_PAGES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Add keyword</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
