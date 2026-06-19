import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section } from './sections';

export function CTASection({
  title = 'Bring the calm home',
  subtitle = 'Set up your family in minutes. Invite everyone. Let the AI handle the rest.',
}: {
  title?: string;
  subtitle?: string;
}) {
  return (
    <Section>
      <div className="glass-card p-10 text-center shadow-glow sm:p-16">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-muted">{subtitle}</p>
        <Link href="/signup" className="mt-8 inline-block">
          <Button size="lg">
            Start your free trial <ArrowRight className="h-5 w-5" />
          </Button>
        </Link>
      </div>
    </Section>
  );
}
