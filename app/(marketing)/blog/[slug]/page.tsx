import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/marketing/sections';
import { getAllPosts, getPost } from '@/lib/blog/posts';
import { fmtDate } from '@/lib/utils/format';

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: 'Post not found' };
  return {
    title: post.title,
    description: post.excerpt,
    openGraph: { type: 'article', title: post.title, description: post.excerpt },
  };
}

export default async function BlogPostPage({ params }: Params) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <Section className="max-w-3xl pt-16">
      <Link href="/blog" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> All posts
      </Link>
      <article className="mt-6">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{fmtDate(post.date, 'MMMM d, yyyy')}</span>
          <span>·</span>
          <span>{post.readingMinutes} min read</span>
          <span>·</span>
          <span>{post.author}</span>
        </div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{post.title}</h1>
        <div className="mt-4 flex gap-2">
          {post.tags.map((t) => (
            <Badge key={t} tone="brand">{t}</Badge>
          ))}
        </div>
        <div className="prose-family mt-8 space-y-5">
          {post.body.map((block, i) =>
            block.type === 'h2' ? (
              <h2 key={i} className="text-xl font-semibold">{block.text}</h2>
            ) : (
              <p key={i} className="leading-relaxed text-muted">{block.text}</p>
            ),
          )}
        </div>
      </article>
    </Section>
  );
}
