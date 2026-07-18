import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import Link from 'next/link';
import {
  AlertTriangle, ArrowRight, CheckCircle2, Cloud, Database, Download,
  Eye, EyeOff, ExternalLink, FileText, Fingerprint, Globe2, HardDrive,
  KeyRound, Lock, Mail, MonitorSmartphone, RefreshCw, ScanFace, Server,
  Shield, ShieldCheck, Trash2, Users, Zap,
} from 'lucide-react';
import { Container, GradientText, PageWrap } from '@/components/marketing/visual-mocks';
import { FAQAccordion } from '@/components/marketing/faq-accordion';
import { cn } from '@/lib/utils/cn';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/security', {
    title: 'Security — Enterprise-Grade Protection for Your Family',
    description:
      'Bank-level encryption, SOC 2 compliance, GDPR/CCPA/HIPAA adherence, and full data sovereignty. Your family\'s privacy is our top priority.',
  });
}

const PILLARS = [
  { icon: Shield, title: 'Privacy by Design', desc: 'Every feature is architected to minimize data exposure and maximize your control.' },
  { icon: Lock, title: 'Bank-Level Security', desc: 'AES-256 encryption, TLS 1.3, and the same standards used by leading financial institutions.' },
  { icon: Users, title: "You're in Control", desc: 'Granular permissions, data export, and instant deletion — always at your fingertips.' },
  { icon: Eye, title: 'Transparent & Accountable', desc: 'Clear policies, public audits, and a dedicated security team you can reach anytime.' },
];

const ARCHITECTURE_LAYERS = [
  {
    icon: Globe2, title: 'Edge Protection', color: 'text-blue-400',
    desc: 'DDoS mitigation, WAF rules, and rate limiting at the edge via Cloudflare. Malicious traffic is blocked before it reaches our infrastructure.',
    details: ['DDoS protection', 'Web Application Firewall', 'Bot detection', 'Rate limiting'],
  },
  {
    icon: Lock, title: 'Transport Security', color: 'text-emerald-400',
    desc: 'All data in transit is encrypted with TLS 1.3. HSTS headers enforce HTTPS. Certificate pinning prevents man-in-the-middle attacks.',
    details: ['TLS 1.3 encryption', 'HSTS preloading', 'Certificate transparency', 'Perfect forward secrecy'],
  },
  {
    icon: ScanFace, title: 'Authentication', color: 'text-violet-400',
    desc: 'Multi-factor authentication, biometric login, secure session tokens with automatic rotation, and brute-force protection.',
    details: ['Multi-factor auth (TOTP/SMS)', 'Biometric login', 'Session token rotation', 'Brute-force lockout'],
  },
  {
    icon: Fingerprint, title: 'Authorization', color: 'text-amber-400',
    desc: 'Row-level security policies ensure family members only access data they are permitted to see. Every API call is authorized individually.',
    details: ['Row-level security (RLS)', 'Role-based access control', 'Per-request authorization', 'Principle of least privilege'],
  },
  {
    icon: Database, title: 'Data Encryption', color: 'text-rose-400',
    desc: 'AES-256 encryption at rest for all data. Encryption keys are managed in a hardware security module (HSM) and rotated automatically.',
    details: ['AES-256 at rest', 'HSM key management', 'Automatic key rotation', 'Column-level encryption for PII'],
  },
  {
    icon: HardDrive, title: 'Backup & Recovery', color: 'text-cyan-400',
    desc: 'Point-in-time recovery with continuous WAL archiving. Encrypted backups stored in geographically separate regions with 30-day retention.',
    details: ['Continuous WAL archiving', 'Point-in-time recovery', 'Geo-redundant backup storage', '30-day backup retention'],
  },
];

const COMPLIANCE_BADGES = [
  {
    badge: 'SOC 2', label: 'SOC 2 Type II', sub: 'Audited annually',
    desc: 'Independent auditors verify our security controls, availability, and confidentiality practices annually.',
  },
  {
    badge: 'GDPR', label: 'GDPR', sub: 'EU compliant',
    desc: 'Full compliance with EU General Data Protection Regulation including data portability and right to erasure.',
  },
  {
    badge: 'HIPAA', label: 'HIPAA', sub: 'Healthcare ready',
    desc: 'We implement administrative, physical, and technical safeguards required for protected health information.',
  },
  {
    badge: 'CCPA', label: 'CCPA', sub: 'California compliant',
    desc: 'California residents have full rights to know, delete, and opt-out of data sale (we never sell data).',
  },
];

const CONTROLS = [
  {
    icon: Users, title: 'Granular Access Controls',
    desc: 'Invite family members and assign specific permissions. Parents manage what children can see and do. Grandparents get a simplified read-only view.',
  },
  {
    icon: Download, title: 'Full Data Portability',
    desc: 'Export all your family\'s data anytime in standard formats (JSON, CSV). Your data belongs to you — always.',
  },
  {
    icon: Trash2, title: 'Instant Deletion',
    desc: 'Permanently delete individual records, a family member\'s data, or your entire account. Deletion is irreversible and includes backups within 30 days.',
  },
  {
    icon: EyeOff, title: 'Zero Ads. Zero Tracking.',
    desc: 'We don\'t show ads, sell data, or track your family across the web. No third-party analytics scripts run on your dashboard.',
  },
  {
    icon: MonitorSmartphone, title: 'Session Management',
    desc: 'View all active sessions, see device details, and revoke access to any device instantly from your security settings.',
  },
  {
    icon: FileText, title: 'Audit Logs',
    desc: 'Every significant action is logged with timestamps. Review who accessed what, when, and from where in your family\'s activity log.',
  },
];

const INCIDENT_TIMELINE = [
  { phase: 'Detection', time: '< 5 min', desc: 'Automated monitoring detects anomalies within minutes via 24/7 alerting systems.', icon: Zap },
  { phase: 'Assessment', time: '< 30 min', desc: 'On-call security engineer assesses severity, scope, and begins containment.', icon: AlertTriangle },
  { phase: 'Notification', time: '< 24 hrs', desc: 'Affected users are notified within 24 hours with clear details and recommended actions.', icon: Mail },
  { phase: 'Resolution', time: 'Ongoing', desc: 'Root cause analysis, remediation, and a public post-mortem for transparency.', icon: CheckCircle2 },
];

const DATA_RESIDENCY = [
  { region: 'United States', location: 'US-East (Virginia)', provider: 'AWS', flag: '🇺🇸' },
  { region: 'European Union', location: 'EU-West (Frankfurt)', provider: 'AWS', flag: '🇪🇺' },
  { region: 'Asia Pacific', location: 'AP-Southeast (Sydney)', provider: 'AWS', flag: '🇦🇺' },
];

const SECURITY_FAQ = [
  { q: 'How is my family\'s data encrypted?', a: 'All data is encrypted in transit using TLS 1.3 and at rest using AES-256 encryption. Encryption keys are stored in hardware security modules (HSMs) and rotated automatically. Sensitive fields like medical records and financial data receive additional column-level encryption.' },
  { q: 'Does Bubaly sell or share my data with third parties?', a: 'Absolutely not. We never sell, rent, or share your family\'s data with any third party for advertising or marketing purposes. The only data sharing that occurs is what you explicitly initiate — like sharing a calendar event or photo with a family member.' },
  { q: 'What happens if I delete my account?', a: 'When you delete your account, all your data is immediately removed from our production systems. Backup copies are purged within 30 days. This process is irreversible. You can also delete individual records or a specific family member\'s data without deleting your entire account.' },
  { q: 'Is my data processed by AI? How is it protected?', a: 'Our AI features process your data only when you explicitly use them (like the AI Assistant or Smart Briefing). AI processing happens in isolated, ephemeral containers. We never use your family\'s data to train AI models. All AI interactions are logged in your audit trail for transparency.' },
  { q: 'How does Bubaly handle children\'s data?', a: 'We comply with COPPA (Children\'s Online Privacy Protection Act) and equivalent international regulations. Children\'s accounts are managed by parent accounts with restricted permissions. We collect the minimum data necessary and provide parents full visibility and control over their children\'s data.' },
  { q: 'What multi-factor authentication options are available?', a: 'We support TOTP-based authenticator apps (Google Authenticator, Authy, 1Password), SMS verification, and biometric authentication (Face ID, Touch ID, fingerprint) on supported devices. We recommend using an authenticator app for the strongest protection.' },
  { q: 'How do you handle security vulnerabilities?', a: 'We maintain a responsible disclosure program and welcome security reports at security@bubaly.com. We acknowledge reports within 24 hours, triage within 48 hours, and keep reporters updated on resolution. We also run regular penetration tests and participate in bug bounty programs.' },
  { q: 'Where is my data stored geographically?', a: 'Your data is stored in the region closest to you — US-East (Virginia), EU-West (Frankfurt), or AP-Southeast (Sydney). All regions are hosted on AWS infrastructure with SOC 2 and ISO 27001 certifications. You can see your data region in your account settings.' },
  { q: 'What is your uptime guarantee?', a: 'We maintain a 99.99% uptime SLA backed by multi-region redundancy, automatic failover, and continuous health monitoring. Our status page at status.bubaly.com provides real-time and historical availability data.' },
  { q: 'How can I report a security concern?', a: 'Email security@bubaly.com with details of your concern. For responsible disclosure of vulnerabilities, include steps to reproduce and we\'ll acknowledge receipt within 24 hours. For urgent account security issues, use the "Lock Account" button in your settings for immediate protection.' },
];

const COMMITMENTS = [
  { text: 'We never sell your data', detail: 'Your family\'s information is never monetized — period.' },
  { text: 'We only collect what we need', detail: 'Minimal data collection with purpose limitation for every field.' },
  { text: 'We protect your data 24/7', detail: 'Automated monitoring, alerting, and on-call security engineers around the clock.' },
  { text: 'We give you full control', detail: 'Export, delete, or modify your data anytime from your dashboard.' },
  { text: 'We\'re transparent about incidents', detail: 'Public post-mortems and proactive notification for any security events.' },
  { text: 'We invest in continuous improvement', detail: 'Regular penetration tests, security audits, and infrastructure upgrades.' },
];

export default function SecurityPage() {
  return (
    <PageWrap>
      {/* Hero */}
      <Container className="pb-0 pt-16 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-100 px-4 py-2 text-sm font-semibold text-violet-800 dark:border-violet-400/30 dark:bg-violet-500/10 dark:text-violet-300">
              <Shield className="h-4 w-4" /> Enterprise-Grade Security
            </div>
            <h1 className="text-5xl font-black leading-[1.06] sm:text-6xl">
              Your family&apos;s privacy<br />
              <span className="gradient-text-violet">is our top priority.</span>
            </h1>
            <p className="mt-6 text-lg leading-8 text-white/65">
              Bubaly is built with the same security standards used by leading banks and healthcare
              providers — because your family deserves nothing less.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="#architecture" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow transition hover:-translate-y-0.5">
                Explore Our Security <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href="#faq" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-bold transition hover:bg-white/[0.06]">
                Security FAQ
              </Link>
            </div>
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
                <ellipse cx="160" cy="340" rx="100" ry="18" fill="#7c5dff" opacity="0.25" />
                <path d="M160 20 L280 70 L280 160 C280 245 220 310 160 345 C100 310 40 245 40 160 L40 70 Z"
                  fill="url(#shieldGrad)" opacity="0.8" />
                <path d="M160 40 L260 82 L260 160 C260 235 208 294 160 325 C112 294 60 235 60 160 L60 82 Z"
                  fill="url(#shieldInner)" />
                <rect x="130" y="155" width="60" height="50" rx="8" fill="white" opacity="0.9" />
                <path d="M148 155 L148 140 C148 128 172 128 172 140 L172 155" stroke="white" strokeWidth="5" fill="none" strokeOpacity="0.9" />
                <circle cx="160" cy="178" r="6" fill="#7c5dff" />
                <rect x="158" y="178" width="4" height="10" rx="2" fill="#7c5dff" />
                {[
                  { cx: 290, cy: 90 }, { cx: 30, cy: 130 },
                  { cx: 295, cy: 200 }, { cx: 25, cy: 220 },
                  { cx: 270, cy: 290 }, { cx: 55, cy: 310 },
                ].map(({ cx, cy }, idx) => (
                  <circle key={idx} cx={cx} cy={cy} r="18" fill="white" opacity="0.06" />
                ))}
              </svg>
            </div>
          </div>
        </div>
      </Container>

      {/* Security Architecture — Defense in Depth */}
      <div id="architecture" />
      <Container className="py-20">
        <div className="mb-12 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">Defense in Depth</p>
          <h2 className="text-3xl font-black sm:text-4xl">Security at Every Layer</h2>
          <p className="mx-auto mt-4 max-w-2xl text-white/55">
            Six layers of protection stand between a threat and your family&apos;s data.
            Each layer is independently audited and continuously monitored.
          </p>
        </div>

        {/* Architecture visual */}
        <div className="relative mx-auto max-w-4xl">
          <div className="absolute left-8 top-0 hidden h-full w-px bg-gradient-to-b from-transparent via-violet-500/30 to-transparent lg:block" />
          <div className="space-y-6">
            {ARCHITECTURE_LAYERS.map(({ icon: Icon, title, color, desc, details }, i) => (
              <div key={title} className="relative grid gap-6 lg:grid-cols-[64px_1fr]">
                <div className="hidden lg:flex lg:flex-col lg:items-center">
                  <div className={cn('relative z-10 grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]')}>
                    <Icon className={cn('h-7 w-7', color)} />
                  </div>
                  <span className="mt-2 text-xs font-bold text-white/40">L{i + 1}</span>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 transition hover:border-violet-400/20">
                  <div className="flex items-center gap-3 lg:hidden">
                    <div className={cn('grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04]')}>
                      <Icon className={cn('h-5 w-5', color)} />
                    </div>
                    <span className="text-xs font-bold text-white/40">Layer {i + 1}</span>
                  </div>
                  <h3 className="mt-3 text-lg font-bold lg:mt-0">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/55">{desc}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {details.map((d) => (
                      <span key={d} className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-xs text-white/60">
                        <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Container>

      {/* Compliance & Certifications */}
      <Container className="py-0">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-12">
          <div className="mb-10 text-center">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">Trust Center</p>
            <h2 className="text-3xl font-black sm:text-4xl">Certified. Compliant. Trusted.</h2>
            <p className="mx-auto mt-4 max-w-2xl text-white/55">
              Bubaly meets and exceeds the highest industry standards. Our compliance posture is independently
              verified and continuously maintained.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {COMPLIANCE_BADGES.map(({ label, sub, badge, desc }) => (
              <div key={label} className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center transition hover:border-violet-400/20">
                <div className="grid h-16 w-16 place-items-center rounded-full bg-violet-600/20">
                  <ShieldCheck className="h-8 w-8 text-violet-300" />
                </div>
                <p className="mt-4 text-sm font-black uppercase tracking-wider text-violet-200">{badge}</p>
                <p className="mt-1 text-xs font-semibold text-white/60">{sub}</p>
                <p className="mt-3 text-xs leading-5 text-white/45">{desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-6 border-t border-white/8 pt-8">
            <div className="flex items-center gap-2 text-sm text-white/50">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>Annual penetration testing</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-white/50">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>Continuous vulnerability scanning</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-white/50">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>Bug bounty program</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-white/50">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>99.99% uptime SLA</span>
            </div>
          </div>
        </div>
      </Container>

      {/* Data Residency */}
      <Container className="py-20">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">Data Sovereignty</p>
            <h2 className="text-3xl font-black sm:text-4xl">Your Data, Your Region</h2>
            <p className="mt-4 text-white/55">
              Choose where your family&apos;s data lives. All regions run on AWS infrastructure with
              SOC 2, ISO 27001, and ISO 27018 certifications. Data never leaves your selected region
              unless you explicitly request a transfer.
            </p>
            <div className="mt-6 space-y-3">
              <div className="flex items-center gap-3 text-sm text-white/60">
                <Cloud className="h-4 w-4 text-violet-300" />
                <span>Multi-AZ deployment for high availability</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white/60">
                <RefreshCw className="h-4 w-4 text-violet-300" />
                <span>Automatic failover within region</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white/60">
                <Server className="h-4 w-4 text-violet-300" />
                <span>Encrypted cross-region backups</span>
              </div>
            </div>
          </div>
          <div className="space-y-4">
            {DATA_RESIDENCY.map(({ region, location, provider, flag }) => (
              <div key={region} className="flex items-center gap-4 rounded-2xl border border-white/8 bg-white/[0.03] p-5 transition hover:border-violet-400/20">
                <span className="text-3xl">{flag}</span>
                <div className="flex-1">
                  <p className="font-bold">{region}</p>
                  <p className="text-sm text-white/50">{location}</p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-white/60">
                  {provider}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Container>

      {/* You Have Full Control */}
      <Container className="py-0">
        <div className="mb-12 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">Your Data, Your Rules</p>
          <h2 className="text-3xl font-black sm:text-4xl">You Have Full Control</h2>
          <p className="mx-auto mt-4 max-w-2xl text-white/55">
            We believe your data belongs to you. These aren&apos;t just words — they&apos;re features
            built into every Bubaly account.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {CONTROLS.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 transition hover:-translate-y-0.5 hover:border-violet-400/20">
              <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                <Icon className="h-6 w-6 text-violet-300" />
              </div>
              <h3 className="text-base font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-white/55">{desc}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* Incident Response */}
      <Container className="py-20">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-12">
          <div className="mb-10 text-center">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">Incident Response</p>
            <h2 className="text-3xl font-black sm:text-4xl">When It Matters Most</h2>
            <p className="mx-auto mt-4 max-w-2xl text-white/55">
              Our incident response protocol is battle-tested and designed for speed,
              transparency, and accountability.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {INCIDENT_TIMELINE.map(({ phase, time, desc, icon: Icon }, i) => (
              <div key={phase} className="relative">
                {i < INCIDENT_TIMELINE.length - 1 && (
                  <div className="absolute right-0 top-8 hidden h-px w-6 bg-white/10 lg:block" style={{ right: '-12px' }} />
                )}
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                  <div className="mb-3 flex items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-600/20">
                      <Icon className="h-5 w-5 text-violet-300" />
                    </div>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-violet-200">Phase {i + 1}</p>
                      <p className="text-sm font-bold">{phase}</p>
                    </div>
                  </div>
                  <p className="mb-2 text-lg font-black text-violet-300">{time}</p>
                  <p className="text-xs leading-5 text-white/50">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Container>

      {/* Responsible Disclosure */}
      <Container className="py-0">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">Responsible Disclosure</p>
            <h2 className="text-3xl font-black sm:text-4xl">Found a Vulnerability?</h2>
            <p className="mt-4 text-white/55">
              We take security vulnerabilities seriously and appreciate the work of security researchers
              who help us keep families safe. Our responsible disclosure program rewards researchers
              who follow coordinated disclosure practices.
            </p>
            <div className="mt-6 space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">24-hour acknowledgment</p>
                  <p className="text-xs text-white/50">We confirm receipt of every report within one business day.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">48-hour triage</p>
                  <p className="text-xs text-white/50">Our security team assesses severity and begins work within 48 hours.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">Safe harbor policy</p>
                  <p className="text-xs text-white/50">Researchers acting in good faith are protected from legal action.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">Credit & recognition</p>
                  <p className="text-xs text-white/50">Researchers are credited on our security acknowledgments page.</p>
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 sm:p-8">
            <h3 className="text-lg font-bold">Report a Vulnerability</h3>
            <p className="mt-2 text-sm leading-6 text-white/55">
              Send your report to our security team. Include a detailed description, steps to reproduce,
              and potential impact. We&apos;ll work with you to understand and address the issue.
            </p>
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <Mail className="h-5 w-5 text-violet-300" />
                <div>
                  <p className="text-xs text-white/50">Email</p>
                  <a href="mailto:security@bubaly.com" className="text-sm font-semibold text-violet-300 hover:text-violet-200">
                    security@bubaly.com
                  </a>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <KeyRound className="h-5 w-5 text-violet-300" />
                <div>
                  <p className="text-xs text-white/50">PGP Key</p>
                  <p className="text-sm font-semibold text-white/70">Available on request</p>
                </div>
              </div>
            </div>
            <p className="mt-4 text-xs text-white/40">
              Please do not report security issues via GitHub issues or public channels.
            </p>
          </div>
        </div>
      </Container>

      {/* Our Commitment */}
      <Container className="py-20">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-12">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-violet-600/20">
                <Shield className="h-8 w-8 text-violet-300" />
              </div>
              <h2 className="text-3xl font-black">Our Commitment to You</h2>
              <p className="mt-4 text-sm leading-7 text-white/65">
                We know families trust us with what matters most. That&apos;s why security isn&apos;t a feature
                we added — it&apos;s the foundation we built on. Every decision, from architecture to
                hiring, prioritizes your family&apos;s safety.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/privacy" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow">
                  Read Our Privacy Policy <ExternalLink className="h-4 w-4" />
                </Link>
                <Link href="/terms" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-bold transition hover:bg-white/[0.06]">
                  Terms of Service
                </Link>
              </div>
            </div>
            <div className="space-y-3">
              {COMMITMENTS.map(({ text, detail }) => (
                <div key={text} className="flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-4 transition hover:border-emerald-400/20">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                  <div>
                    <p className="text-sm font-bold">{text}</p>
                    <p className="mt-0.5 text-xs text-white/50">{detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Container>

      {/* Security FAQ */}
      <div id="faq" />
      <Container className="py-0 pb-20">
        <div className="mb-10 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">Common Questions</p>
          <h2 className="text-3xl font-black sm:text-4xl">Security FAQ</h2>
          <p className="mx-auto mt-4 max-w-2xl text-white/55">
            Everything you need to know about how we protect your family&apos;s data.
          </p>
        </div>
        <FAQAccordion items={SECURITY_FAQ} />
      </Container>

      {/* Contact Security Team */}
      <div className="border-t border-white/8 py-10">
        <Container>
          <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:text-left">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-violet-600/20">
              <Shield className="h-7 w-7 text-violet-300" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold">Have a Security Question?</h2>
              <p className="mt-1 text-sm text-white/55">
                Our security team is here to help. Reach out anytime — we respond within 24 hours.
              </p>
            </div>
            <div className="flex gap-3">
              <a href="mailto:security@bubaly.com" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow">
                <Mail className="h-4 w-4" /> Contact Security Team
              </a>
            </div>
          </div>
        </Container>
      </div>
    </PageWrap>
  );
}
