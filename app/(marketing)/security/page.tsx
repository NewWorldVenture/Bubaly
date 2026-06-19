import type { Metadata } from 'next';
import { Shield, Lock, KeyRound, FileCheck, EyeOff, ScrollText } from 'lucide-react';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';

export const metadata: Metadata = {
  title: 'Security',
  description: 'How FamilyOS keeps your family’s data private: row-level security, encrypted storage, signed URLs, and audit logging.',
};

const POINTS = [
  { icon: Shield, title: 'Row-level security everywhere', description: 'Every one of our 32 database tables enforces row-level security. A hard guarantee: no row ever crosses a family boundary.' },
  { icon: EyeOff, title: 'No cross-family leakage', description: 'Access is gated by a verified membership check on every read and write. One family can never see another’s data — by construction.' },
  { icon: Lock, title: 'Private document vault', description: 'Documents live in a private storage bucket and are served only through short-lived signed URLs. Nothing is public.' },
  { icon: KeyRound, title: 'Secure, invite-only access', description: 'Families are invite-only. Joining requires a tokenized invite issued to your specific email and verified server-side.' },
  { icon: ScrollText, title: 'Audit logging', description: 'Important actions are recorded to an append-only audit log that only household managers can read.' },
  { icon: FileCheck, title: 'Least-privilege roles', description: 'Six roles from Parent to Guest ensure each member has exactly the access they need — and nothing more.' },
];

export default function SecurityPage() {
  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow="Security"
          title="Your family’s data, protected by design"
          description="Privacy isn’t a setting in FamilyOS — it’s built into the foundation."
        />
      </Section>
      <Section className="pt-0">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((p) => (
            <FeatureCard key={p.title} {...p} />
          ))}
        </div>
        <div className="glass-card mx-auto mt-10 max-w-3xl p-7">
          <h3 className="text-lg font-semibold">The technical short version</h3>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            <li>• Supabase Auth with secure, HTTP-only session cookies and middleware-refreshed sessions.</li>
            <li>• A <code className="text-fg">SECURITY DEFINER</code> membership function backs every RLS policy, preventing recursion and bypass.</li>
            <li>• The service-role key is server-only — the browser and AI assistant only ever use the scoped anon key.</li>
            <li>• Secrets live in environment variables; nothing sensitive is committed to the repo.</li>
            <li>• Input is validated on the client and enforced again at the database.</li>
          </ul>
        </div>
      </Section>
      <CTASection title="Privacy your family can trust" subtitle="Set up a secure household in minutes." />
    </>
  );
}
