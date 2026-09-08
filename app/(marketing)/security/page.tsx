// /security — the Trust Center.
//
// What Bubaly may do, what it asks, and what we can prove. Every claim on this
// page is one of four things, and says which: verified by a test in this repo,
// in place as a process, inherited from a provider, or planned. The
// always-asks list is rendered from HIGH_STAKES_AI_DOMAINS so the page cannot
// promise less caution than lib/trust/engine.ts enforces.
//
// tests/marketing-trust-ledger.test.ts fails the build if any retired claim
// creeps back in — through the markup, or through a catalogue value the page
// renders. The retired phrases are listed there, in RETIRED_CLAIMS, and
// nowhere else: naming one here would ship it in this file's source and trip
// the very guard it describes.
//
// Module-level data holds catalogue KEYS only, never English: this page sits
// on the gated marketing-pages surface, and a label beside its key would be a
// literal the scanner rightly reports. The English lives in en-US.json.
import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import Link from 'next/link';
import {
  AlertTriangle, ArrowRight, CheckCircle2, Database, Download, Eye, EyeOff, ExternalLink,
  FileText, Fingerprint, HardDrive, KeyRound, ListChecks, Lock, Mail, ScanFace, Shield, ShieldCheck,
  Sparkles, Users, Zap, type LucideIcon,
} from 'lucide-react';
import { Container, PageWrap, Pill } from '@/components/marketing/visual-mocks';
import { FAQAccordion } from '@/components/marketing/faq-accordion';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { TrustLedger } from '@/components/marketing/trust-ledger';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';
import { HIGH_STAKES_GROUP_ORDER, highStakesGroups, trustDomainKey, trustGroupKey } from '@/lib/marketing/trust-copy';
import { ROLE_DEFAULTS, type TrustRole } from '@/lib/trust/engine';
import { getPublicStats } from '@/lib/marketing/stats';
import { handledNote } from '@/lib/marketing/format';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/security', {
    title: t('security.trustCenterMetaTitle'),
    description: t('security.honestDescription'),
  });
}

const PILLARS: { icon: LucideIcon; title: string; desc: string }[] = [
  { icon: Shield, title: 'security.privacyByDesign', desc: 'security.privacyByDesignBody' },
  { icon: Lock, title: 'security.encryptedInTransitAndAtRest', desc: 'security.encryptedInTransitAndAtRestBody' },
  { icon: Users, title: 'security.youreInControl', desc: 'security.youreInControlBody' },
  { icon: Eye, title: 'security.transparentAccountable', desc: 'security.clearPoliciesPublishedLog' },
];

// Trimmed to what the code and our providers actually do: TLS, row-level
// security and role defaults, provider encryption at rest, provider backups.
const ARCHITECTURE_LAYERS: { icon: LucideIcon; color: string; title: string; desc: string; details: string[] }[] = [
  {
    icon: Lock, color: 'text-emerald-400',
    title: 'security.layerTransportTitle',
    desc: 'security.layerTransportBody',
    details: ['security.detailTls', 'security.detailHsts', 'trustCenter.rowCsp'],
  },
  {
    icon: Fingerprint, color: 'text-amber-400',
    title: 'security.layerAuthorizationTitle',
    desc: 'security.layerAuthorizationBody',
    details: ['security.detailRls', 'security.detailRbac', 'security.detailLeastPrivilege'],
  },
  {
    icon: Database, color: 'text-rose-400',
    title: 'security.layerAtRestTitle',
    desc: 'security.layerAtRestBody',
    details: ['security.detailProviderEncryption', 'security.detailSignedUrls'],
  },
  {
    icon: HardDrive, color: 'text-cyan-400',
    title: 'security.layerBackupTitle',
    desc: 'security.layerBackupBody',
    details: ['security.detailProviderBackups', 'security.detailPitr'],
  },
];

const CONTROLS: { icon: LucideIcon; title: string; desc: string }[] = [
  { icon: Users, title: 'security.controlAccessTitle', desc: 'security.controlAccessBody' },
  { icon: Download, title: 'security.controlExportTitle', desc: 'security.controlExportBody' },
  { icon: EyeOff, title: 'security.controlNoAdsTitle', desc: 'security.controlNoAdsBody' },
  { icon: ListChecks, title: 'security.controlLedgerTitle', desc: 'security.controlLedgerBody' },
];

// Our incident policy. It is a policy — the page labels it as one.
const INCIDENT_TIMELINE: { icon: LucideIcon; phase: string; desc: string }[] = [
  { icon: Zap, phase: 'security.incidentDetection', desc: 'security.incidentDetectionBody' },
  { icon: AlertTriangle, phase: 'security.incidentAssessment', desc: 'security.incidentAssessmentBody' },
  { icon: Mail, phase: 'security.incidentNotification', desc: 'security.incidentNotificationBody' },
  { icon: CheckCircle2, phase: 'security.incidentResolution', desc: 'security.incidentResolutionBody' },
];

const SECURITY_FAQ: { q: string; a: string }[] = [
  { q: 'security.faqEncryptionQ', a: 'security.faqEncryptionAnswer' },
  { q: 'security.faqSellDataQ', a: 'security.faqSellDataAnswer' },
  { q: 'security.faqDeleteQ', a: 'security.faqDeleteAnswer' },
  { q: 'security.faqAiQ', a: 'security.faqAiAnswer' },
  { q: 'security.faqChildrenQ', a: 'security.faqChildrenAnswer' },
  { q: 'security.faqVulnerabilitiesQ', a: 'security.faqVulnerabilitiesAnswer' },
  { q: 'security.faqRegionQ', a: 'security.faqRegionAnswer' },
  { q: 'security.faqUptimeQ', a: 'security.faqUptimeAnswer' },
  { q: 'security.faqReportQ', a: 'security.faqReportAnswer' },
];

const COMMITMENTS: { text: string; detail: string }[] = [
  { text: 'security.commitNeverSell', detail: 'security.commitNeverSellDetail' },
  { text: 'security.commitMinimal', detail: 'security.commitMinimalDetail' },
  { text: 'security.commitMonitor', detail: 'security.commitMonitorDetail' },
  { text: 'security.commitControl', detail: 'security.commitControlDetail' },
  { text: 'security.commitTransparent', detail: 'security.commitTransparentDetail' },
  { text: 'security.plannedIndependentTesting', detail: 'security.plannedIndependentTestingDetail' },
];

const DISCLOSURE_STEPS: [string, string][] = [
  ['security.ack24', 'security.weConfirmReceiptOfEvery'],
  ['security.triage48', 'security.ourSecurityTeamAssessesSeverity'],
  ['security.safeHarborPolicy', 'security.researchersActingInGoodFaith'],
  ['security.creditRecognition', 'security.researchersAreCreditedOnOur'],
];

const AI_STATEMENTS = ['trustCenter.ai1', 'trustCenter.ai2', 'trustCenter.ai3', 'trustCenter.ai4', 'trustCenter.ai5', 'trustCenter.ai6'] as const;

const ROLE_LABEL_KEY: Record<TrustRole, string> = {
  parent: 'trustCenter.roleParent',
  adult: 'trustCenter.roleAdult',
  teen: 'trustCenter.roleTeen',
  child: 'trustCenter.roleChild',
  caregiver: 'trustCenter.roleCaregiver',
  guest: 'trustCenter.roleGuest',
};

const ROLE_ORDER: TrustRole[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];

export default async function SecurityPage() {
  const t = await getTranslations();
  const stats = await getPublicStats();
  const groups = highStakesGroups();
  // The real aggregate, shown only when the formatter says it is large enough
  // to print. Below the threshold the line does not exist — no "0", no dash.
  const handledLine = handledNote(t, stats.handledCompleted);

  return (
    <PageWrap>
      {/* Hero */}
      <Container className="pb-0 pt-16 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <Pill icon={ShieldCheck}>{t('trustCenter.eyebrow')}</Pill>
            <h1 className="mt-5 text-balance text-4xl font-black leading-[1.08] sm:text-5xl lg:text-6xl">{t('trustCenter.title')}</h1>
            <p className="mt-6 text-lg leading-8 text-white/65">{t('trustCenter.body')}</p>
            {handledLine && (
              <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100">
                <Sparkles className="h-4 w-4 text-emerald-300" aria-hidden />
                {handledLine}
              </p>
            )}
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="#ai-trust" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow transition hover:-translate-y-0.5">
                {t('trustCenter.aiTitle')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link href="#ledger" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-bold transition hover:bg-white/[0.06]">{t('trustCenter.ledgerLink')}</Link>
            </div>
            <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4 lg:grid-cols-2">
              {PILLARS.map(({ icon: Icon, title, desc }) => (
                <div key={title}>
                  <div className="mb-2 grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                    <Icon className="h-5 w-5 text-violet-300" aria-hidden />
                  </div>
                  <p className="text-sm font-bold">{t(title)}</p>
                  <p className="mt-1 text-xs leading-5 text-white/55">{t(desc)}</p>
                </div>
              ))}
            </div>
          </div>
          {/* Shield illustration */}
          <div className="flex items-center justify-center">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-violet-600/20 blur-[80px]" />
              <svg viewBox="0 0 320 380" className="relative h-72 w-72 lg:h-80 lg:w-80" fill="none" aria-hidden>
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

      {/* How the assistant is allowed to act */}
      <Container className="py-20">
        <section id="ai-trust" className="scroll-mt-24 rounded-3xl border border-white/8 bg-white/[0.025] p-6 sm:p-10">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
            <div>
              <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('trustCenter.eyebrow')}</p>
              <h2 className="text-3xl font-black sm:text-4xl">{t('trustCenter.aiTitle')}</h2>
              <ol className="mt-8 space-y-5">
                {AI_STATEMENTS.map((key, index) => (
                  <li key={key} className="flex items-start gap-4">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-violet-400/40 bg-violet-500/10 text-xs font-bold text-violet-200">{index + 1}</span>
                    <div className="min-w-0">
                      <p className="text-sm leading-6 text-white/80 sm:text-base sm:leading-7">{t(key)}</p>
                      {key === 'trustCenter.ai2' && (
                        // Rendered from HIGH_STAKES_AI_DOMAINS via trust-copy, never retyped.
                        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2" data-always-asks>
                          {HIGH_STAKES_GROUP_ORDER.filter((group) => groups[group].length > 0).map((group) => (
                            <li key={group} className="text-sm leading-6 text-white/75">
                              <span className="font-semibold text-white/90">{t(trustGroupKey(group))}:</span>{' '}
                              {groups[group].map((domain) => t(trustDomainKey(domain))).join(', ')}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/dashboard/trust" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-5 py-2.5 text-sm font-bold transition hover:bg-white/[0.06]">
                  <ScanFace className="h-4 w-4 text-violet-300" aria-hidden />
                  {t('trustCenter.manageLink')}
                </Link>
                <Link href="/ai" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-violet-300 transition hover:bg-white/[0.045]">
                  {t('decisionsBand.seeItAct')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            </div>

            {/* Who can do what by default — read from ROLE_DEFAULTS */}
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5 sm:p-6">
              <h3 className="text-lg font-bold">{t('trustCenter.rolesTitle')}</h3>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[320px] text-left text-sm">
                  <thead>
                    <tr className="text-[11px] font-semibold uppercase tracking-wider text-white/45">
                      <th scope="col" className="pb-2 pr-4 font-semibold">{t('trustCenter.roleHeader')}</th>
                      <th scope="col" className="pb-2 font-semibold">{t('trustCenter.automationHeader')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/8">
                    {ROLE_ORDER.map((role) => {
                      const trusted = ROLE_DEFAULTS[role].automationTrusted;
                      return (
                        <tr key={role}>
                          <th scope="row" className="py-2.5 pr-4 font-semibold text-white/90">{t(ROLE_LABEL_KEY[role])}</th>
                          <td className="py-2.5 text-white/70">
                            <span className="inline-flex items-start gap-2">
                              {trusted
                                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                                : <Users className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" aria-hidden />}
                              {trusted ? t('trustCenter.automationTrusted') : t('trustCenter.automationNeedsParent')}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-xs leading-5 text-white/50">{t('trustCenter.healthNote')}</p>
            </div>
          </div>
        </section>
      </Container>

      {/* Verified, in place, inherited, or still planned */}
      <Container className="py-0">
        <TrustLedger />
      </Container>

      {/* Security at every layer */}
      <div id="architecture" />
      <Container className="py-20">
        <div className="mb-12 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.defenseInDepth')}</p>
          <h2 className="text-3xl font-black sm:text-4xl">{t('security.securityAtEveryLayer')}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-white/55">{t('security.layersIntro')}</p>
        </div>

        <div className="relative mx-auto max-w-4xl">
          <div className="absolute left-8 top-0 hidden h-full w-px bg-gradient-to-b from-transparent via-violet-500/30 to-transparent lg:block" />
          <div className="space-y-6">
            {ARCHITECTURE_LAYERS.map(({ icon: Icon, title, color, desc, details }, i) => (
              <div key={title} className="relative grid gap-6 lg:grid-cols-[64px_1fr]">
                <div className="hidden lg:flex lg:flex-col lg:items-center">
                  <div className="relative z-10 grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
                    <Icon className={cn('h-7 w-7', color)} aria-hidden />
                  </div>
                  <span className="mt-2 text-xs font-bold text-white/40">{i + 1}</span>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 transition hover:border-violet-400/20">
                  <div className="flex items-center gap-3 lg:hidden">
                    <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                      <Icon className={cn('h-5 w-5', color)} aria-hidden />
                    </div>
                    <span className="text-xs font-bold text-white/40">{i + 1}</span>
                  </div>
                  <h3 className="mt-3 text-lg font-bold lg:mt-0">{t(title)}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/55">{t(desc)}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {details.map((d) => (
                      <span key={d} className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-xs text-white/60">
                        <CheckCircle2 className="h-3 w-3 text-emerald-400" aria-hidden />
                        {t(d)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Container>

      {/* Data region — one region today, a choice of region is planned */}
      <Container className="py-0">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-12">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.dataSovereignty')}</p>
          <h2 className="text-3xl font-black sm:text-4xl">{t('security.yourDataYourRegion')}</h2>
          <p className="mt-4 max-w-3xl text-white/65">{t('security.dataRegionToday')}</p>
          <Link href="#ledger-data_region" className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-violet-300 hover:text-violet-200">
            {t('trustCenter.rowDataRegion')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </Container>

      {/* You have control */}
      <Container className="py-20">
        <div className="mb-12 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.yourDataYourRules')}</p>
          <h2 className="text-3xl font-black sm:text-4xl">{t('security.youHaveFullControl')}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-white/55">{t('security.controlsIntro')}</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {CONTROLS.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 transition hover:-translate-y-0.5 hover:border-violet-400/20">
              <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                <Icon className="h-6 w-6 text-violet-300" aria-hidden />
              </div>
              <h3 className="text-base font-bold">{t(title)}</h3>
              <p className="mt-2 text-sm leading-6 text-white/55">{t(desc)}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* Incident response — a policy, labelled as one */}
      <Container className="py-0">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-12">
          <div className="mb-10 text-center">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.incidentResponse')}</p>
            <h2 className="text-3xl font-black sm:text-4xl">{t('security.whenItMattersMost')}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-white/55">{t('security.incidentProtocol')}</p>
            <p className="mx-auto mt-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-white/60">
              <FileText className="h-3.5 w-3.5" aria-hidden />
              {t('security.policyNotCertification')}
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {INCIDENT_TIMELINE.map(({ phase, desc, icon: Icon }, i) => (
              <div key={phase} className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-600/20">
                    <Icon className="h-5 w-5 text-violet-300" aria-hidden />
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-violet-200">{i + 1}</p>
                    <p className="text-sm font-bold">{t(phase)}</p>
                  </div>
                </div>
                <p className="text-xs leading-5 text-white/50">{t(desc)}</p>
              </div>
            ))}
          </div>
        </div>
      </Container>

      {/* Responsible disclosure */}
      <Container className="py-20">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.responsibleDisclosure')}</p>
            <h2 className="text-3xl font-black sm:text-4xl">{t('security.foundAVulnerability')}</h2>
            <p className="mt-4 text-white/55">{t('security.disclosureIntro')}</p>
            <div className="mt-6 space-y-4">
              {DISCLOSURE_STEPS.map(([titleKey, bodyKey]) => (
                <div key={titleKey} className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
                  <div>
                    <p className="text-sm font-bold">{t(titleKey)}</p>
                    <p className="text-xs text-white/50">{t(bodyKey)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 sm:p-8">
            <h3 className="text-lg font-bold">{t('security.reportAVulnerability')}</h3>
            <p className="mt-2 text-sm leading-6 text-white/55">{t('security.sendYourReport')}</p>
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <Mail className="h-5 w-5 text-violet-300" aria-hidden />
                <div>
                  <p className="text-xs text-white/50">{t('security.email')}</p>
                  <a href="mailto:security@bubaly.com" className="text-sm font-semibold text-violet-300 hover:text-violet-200">
                    security@bubaly.com
                  </a>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <KeyRound className="h-5 w-5 text-violet-300" aria-hidden />
                <div>
                  <p className="text-xs text-white/50">{t('security.pgpKey')}</p>
                  <p className="text-sm font-semibold text-white/70">{t('security.availableOnRequest')}</p>
                </div>
              </div>
            </div>
            <p className="mt-4 text-xs text-white/40">{t('security.doNotReportPublicly')}</p>
          </div>
        </div>
      </Container>

      {/* Our commitment */}
      <Container className="py-0">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-12">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-violet-600/20">
                <Shield className="h-8 w-8 text-violet-300" aria-hidden />
              </div>
              <h2 className="text-3xl font-black">{t('security.ourCommitmentToYou')}</h2>
              <p className="mt-4 text-sm leading-7 text-white/65">{t('security.commitmentBody')}</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/privacy" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow">{t('security.readOurPrivacyPolicy')}{' '}<ExternalLink className="h-4 w-4" aria-hidden />
                </Link>
                <Link href="/terms" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-bold transition hover:bg-white/[0.06]">{t('security.termsOfService')}</Link>
              </div>
            </div>
            <div className="space-y-3">
              {COMMITMENTS.map(({ text, detail }) => (
                <div key={text} className="flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-4 transition hover:border-emerald-400/20">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
                  <div>
                    <p className="text-sm font-bold">{t(text)}</p>
                    <p className="mt-0.5 text-xs text-white/50">{t(detail)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Container>

      {/* Security FAQ */}
      <div id="faq" />
      <Container className="py-20">
        <div className="mb-10 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.commonQuestions')}</p>
          <h2 className="text-3xl font-black sm:text-4xl">{t('security.securityFaq')}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-white/55">{t('security.faqIntro')}</p>
        </div>
        <FAQAccordion items={SECURITY_FAQ.map(({ q, a }) => ({ q: t(q), a: t(a) }))} />
      </Container>

      {/* Contact the security team */}
      <div className="border-t border-white/8 py-10">
        <Container>
          <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:text-left">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-violet-600/20">
              <Shield className="h-7 w-7 text-violet-300" aria-hidden />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold">{t('security.haveASecurityQuestion')}</h2>
              <p className="mt-1 text-sm text-white/55">{t('security.teamIsHereToHelp')}</p>
            </div>
            <div className="flex gap-3">
              <a href="mailto:security@bubaly.com" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow">
                <Mail className="h-4 w-4" aria-hidden />{' '}{t('security.contactSecurityTeam')}</a>
            </div>
          </div>
        </Container>
      </div>
      <MarketingAeoSection path="/security" name={t('security.trustCenterAeoName')} description={t('security.honestDescription')} />
    </PageWrap>
  );
}
