import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { getAllPosts } from '@/lib/blog/posts';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Ideas on running a calmer, more connected household — from the FamilyOS team.',
};

export default function BlogPage() {
  const posts = getAllPosts();
  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading eyebrow="Blog" title="A calmer, more connected home" description="Practical ideas for busy families." />
      </Section>
      <Section className="pt-0">
        <div className="mx-auto grid max-w-4xl gap-5">
          {posts.map((post) => (
            <Link key={post.slug} href={`/blog/${post.slug}`} className="glass-card group p-6 transition hover:-translate-y-0.5 hover:shadow-glow">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{fmtDate(post.date, 'MMMM d, yyyy')}</span>
                <span>·</span>
                <span>{post.readingMinutes} min read</span>
              </div>
              <h2 className="mt-2 text-xl font-semibold">{post.title}</h2>
              <p className="mt-2 text-sm text-muted">{post.excerpt}</p>
              <div className="mt-4 flex items-center justify-between">
                <div className="flex gap-2">
                  {post.tags.map((t) => (
                    <Badge key={t} tone="neutral">{t}</Badge>
                  ))}
                </div>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-brand">
                  Read <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </Section>
    </>
  );
}
