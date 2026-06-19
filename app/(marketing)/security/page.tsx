import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight, CheckCircle2, Database, Download, Eye, EyeOff,
  FileText, KeyRound, Lock, RefreshCw, Server, Shield, Trash2, Users, ExternalLink,
} from 'lucide-react';
import { Container, GradientText, PageWrap } from '@/components/marketing/visual-mocks';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = {
  title: 'Security',
  description: 'Your family\'s privacy is our top priority. Enterprise-grade security built into every layer.',
};

const PILLARS = [
  { icon: Shield, title: 'Privacy by Design', desc: 'Built from the ground up to protect your data.' },
  { icon: Lock, title: 'Industry Leading Security', desc: 'We use the same standards as top financial institutions.' },
  { icon: Users, title: "You're in Control", desc: 'Manage permissions and data at any time.' },
  { icon: Eye, title: 'Transparent & Accountable', desc: 'Clear policies and no surprises, ever.' },
];

const LAYERS = [
  { icon: Database, title: 'Data Encryption', desc: 'All data is encrypted in transit and at rest using AES-256 encryption.' },
  { icon: Server, title: 'Secure Cloud Infrastructure', desc: 'Hosted on AWS with world-class security, redundancy, and 99.99% uptime.' },
  { icon: KeyRound, title: 'Multi-Factor Authentication', desc: 'Add an extra layer of security to your account with MFA.' },
  { icon: Users, title: 'Granular Permissions', desc: "Control who can view and edit each part of your family's information." },
  { icon: RefreshCw, title: 'Automatic Backups', desc: "We automatically backup your data so you never have to worry." },
  { icon: EyeOff, title: 'Privacy First', desc: 'We never sell your data. Ever. Your family\'s trust means everything to us.' },
];

const COMPLIANCE = [
  { label: 'SOC 2 Type II', sub: 'Compliant', badge: 'SOC 2' },
  { label: 'GDPR', sub: 'Compliant', badge: 'GDPR' },
  { label: 'HIPAA', sub: 'Compliant', badge: 'HIPAA' },
  { label: 'CCPA', sub: 'Compliant', badge: 'CCPA' },
];

const CONTROLS = [
  { icon: Users, title: 'Access Controls', desc: 'Invite family members and decide what they can see and do.', link: 'Learn more' },
  { icon: Download, title: 'Export Your Data', desc: "Download your family's data anytime, in a portable format.", link: 'Learn more' },
  { icon: Trash2, title: 'Delete Anytime', desc: 'Permanently delete your data or your entire account.', link: 'Learn more' },
  { icon: EyeOff, title: 'No Ads. No Tracking.', desc: "We don't show ads or track your family across the web.", link: 'Learn more' },
];

const COMMITMENTS = [
  'We never sell your data',
  'We only collect what we need',
  'We protect your data 24/7',
  "We're here if you have questions",
];

export default function SecurityPage() {
  return (
    <PageWrap>
      {/* Hero */}
      <Container className="pb-0 pt-16 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-500/10 px-4 py-2 text-sm font-semibold text-violet-300">
              <Shield className="h-4 w-4" /> Security You Can Trust
            </div>
            <h1 className="text-5xl font-black leading-[1.06] sm:text-6xl">
              Your family&apos;s privacy<br />
              <span className="gradient-text-violet">is our top priority.</span>
            </h1>
            <p className="mt-6 text-lg leading-8 text-white/65">
              FamilyOS is built with enterprise-grade security to keep your family&apos;s data safe, private, and secure.
            </p>
            <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4 lg:grid-cols-2">
              {PILLARS.map(({ icon: Icon, title, desc }) => (
                <div key={title}>
                  <div className="mb-2 grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                    <Icon className="h-5 w-5 text-violet-300" />
                  </div>
                  <p className="text-sm font-bold">{title}</p>
                  <p className="mt-1 text-xs leading-5 text-white/55">{desc}</p>
                </div>
              ))}
            </div>
          </div>
          {/* Shield illustration */}
          <div className="flex items-center justify-center">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-violet-600/20 blur-[80px]" />
              <svg viewBox="0 0 320 380" className="relative h-72 w-72 lg:h-80 lg:w-80" fill="none">
                <defs>
                  <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#7c5dff" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.7" />
                  </linearGradient>
                  <linearGradient id="shieldInner" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#818cf8" stopOpacity="0.1" />
                  </linearGradient>
                </defs>
                {/* Outer glow ring */}
                <ellipse cx="160" cy="340" rx="100" ry="18" fill="#7c5dff" opacity="0.25" />
                {/* Shield body */}
                <path d="M160 20 L280 70 L280 160 C280 245 220 310 160 345 C100 310 40 245 40 160 L40 70 Z"
                  fill="url(#shieldGrad)" opacity="0.8" />
                <path d="M160 40 L260 82 L260 160 C260 235 208 294 160 325 C112 294 60 235 60 160 L60 82 Z"
                  fill="url(#shieldInner)" />
                {/* Lock icon */}
                <rect x="130" y="155" width="60" height="50" rx="8" fill="white" opacity="0.9" />
                <path d="M148 155 L148 140 C148 128 172 128 172 140 L172 155" stroke="white" strokeWidth="5" fill="none" strokeOpacity="0.9" />
                <circle cx="160" cy="178" r="6" fill="#7c5dff" />
                <rect x="158" y="178" width="4" height="10" rx="2" fill="#7c5dff" />
                {/* Floating icons */}
                {[
                  { cx: 290, cy: 90, icon: '📅' }, { cx: 30, cy: 130, icon: '👤' },
                  { cx: 295, cy: 200, icon: '🖼️' }, { cx: 25, cy: 220, icon: '📄' },
                  { cx: 270, cy: 290, icon: '❤️' }, { cx: 55, cy: 310, icon: '📊' },
                ].map(({ cx, cy }, idx) => (
                  <circle key={idx} cx={cx} cy={cy} r="18" fill="white" opacity="0.06" />
                ))}
              </svg>
            </div>
          </div>
        </div>
      </Container>

      {/* Security at Every Layer */}
      <Container className="py-16">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-black sm:text-4xl">Security at Every Layer</h2>
          <p className="mt-3 text-white/55">
            We follow a defense-in-depth approach to keep your family&apos;s information safe.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {LAYERS.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 transition hover:-translate-y-0.5 hover:border-violet-400/30">
              <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                <Icon className="h-6 w-6 text-violet-300" />
              </div>
              <h3 className="text-base font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-white/55">{desc}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* Certified */}
      <Container className="py-0">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-10">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="text-2xl font-black sm:text-3xl">Certified. Compliant. Trusted.</h2>
              <p className="mt-3 text-white/55">FamilyOS meets and exceeds the highest industry standards.</p>
              <p className="mt-5 text-sm leading-7 text-white/65">
                We are SOC 2 Type II compliant and adhere to strict data protection regulations including GDPR,
                CCPA, and HIPAA (where applicable).
              </p>
              <Link href="#" className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-300 hover:text-violet-200">
                View Compliance Details <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
              {COMPLIANCE.map(({ label, sub, badge }) => (
                <div key={label} className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-center">
                  <div className="grid h-14 w-14 place-items-center rounded-full bg-violet-600/20">
                    <Shield className="h-7 w-7 text-violet-300" />
                  </div>
                  <p className="mt-3 text-xs font-black uppercase tracking-wider text-violet-200">{badge}</p>
                  <p className="mt-1 text-xs text-white/45">{sub}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Container>

      {/* You Have Full Control */}
      <Container className="py-16">
        <h2 className="mb-10 text-center text-3xl font-black sm:text-4xl">You Have Full Control</h2>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {CONTROLS.map(({ icon: Icon, title, desc, link }) => (
            <div key={title} className="flex flex-col items-center border-r border-white/8 px-4 text-center last:border-0 sm:border-0 lg:border-r">
              <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.03]">
                <Icon className="h-7 w-7 text-violet-300" />
              </div>
              <h3 className="font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-white/55">{desc}</p>
              <Link href="#" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-violet-300 hover:text-violet-200">
                {link} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          ))}
        </div>
      </Container>

      {/* Our Commitment CTA */}
      <Container className="pb-20">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-10">
          <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
            <div>
              <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-violet-600/20">
                <Shield className="h-8 w-8 text-violet-300" />
              </div>
              <h2 className="text-2xl font-black">Our Commitment to You</h2>
              <p className="mt-4 text-sm leading-7 text-white/65">
                We know families trust us with what matters most. That&apos;s why we&apos;re committed to transparency,
                security, and protecting your family—always.
              </p>
              <Link href="/privacy" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow">
                Read Our Privacy Policy <ExternalLink className="h-4 w-4" />
              </Link>
            </div>
            <div className="space-y-3">
              {COMMITMENTS.map((c) => (
                <div key={c} className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                  <span className="text-sm">{c}</span>
                </div>
              ))}
              <Link href="mailto:security@familyos.com" className="mt-4 flex items-center gap-1 text-sm font-semibold text-violet-300 hover:text-violet-200">
                Contact our security team →
              </Link>
            </div>
          </div>
        </div>
      </Container>

      {/* Footer strip */}
      <div className="border-t border-white/8 py-6">
        <p className="text-center text-sm text-white/45">
          Your family&apos;s trust is at the heart of everything we do. If you ever have a question, we&apos;re here to help.
        </p>
        <p className="mt-1 text-center text-sm">
          <a href="mailto:security@familyos.com" className="text-violet-300 hover:text-violet-200">security@familyos.com</a>
        </p>
      </div>
    </PageWrap>
  );
}
