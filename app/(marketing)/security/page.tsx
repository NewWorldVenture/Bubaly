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
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/security', {
    title: t('security.securityEnterpriseGradeProtectionFor'),
    description:
      'Bank-level encryption, SOC 2 compliance, GDPR/CCPA/HIPAA adherence, and full data sovereignty. Your family\'s privacy is our top priority.',
  });
}

const PILLARS = [
  { icon: Shield, title: 'security.privacyByDesign', desc: 'security.everyFeatureIsArchitectedTo' },
  { icon: Lock, title: 'security.bankLevelSecurity', desc: 'security.aes256EncryptionTls1' },
  { icon: Users, title: "You're in Control", desc: 'Granular permissions, data export, and instant deletion — always at your fingertips.' },
  { icon: Eye, title: 'security.transparentAccountable', desc: 'security.clearPoliciesPublicAuditsAnd' },
];

const ARCHITECTURE_LAYERS = [
  {
    icon: Globe2, title: 'security.edgeProtection', color: 'text-blue-400',
    desc: 'security.ddosMitigationWafRulesAnd',
    details: ['security.ddosProtection', 'security.webApplicationFirewall', 'security.botDetection', 'security.rateLimiting'],
  },
  {
    icon: Lock, title: 'security.transportSecurity', color: 'text-emerald-400',
    desc: 'security.allDataInTransitIs',
    details: ['security.tls13Encryption', 'security.hstsPreloading', 'security.certificateTransparency', 'security.perfectForwardSecrecy'],
  },
  {
    icon: ScanFace, title: 'security.authentication', color: 'text-violet-400',
    desc: 'security.multiFactorAuthenticationBiometricLogin',
    details: ['Multi-factor auth (TOTP/SMS)', 'security.biometricLogin', 'security.sessionTokenRotation', 'security.bruteForceLockout'],
  },
  {
    icon: Fingerprint, title: 'security.authorization', color: 'text-amber-400',
    desc: 'security.rowLevelSecurityPoliciesEnsure',
    details: ['Row-level security (RLS)', 'security.roleBasedAccessControl', 'security.perRequestAuthorization', 'security.principleOfLeastPrivilege'],
  },
  {
    icon: Database, title: 'security.dataEncryption', color: 'text-rose-400',
    desc: 'security.aes256EncryptionAtRest',
    details: ['security.aes256AtRest', 'security.hsmKeyManagement', 'security.automaticKeyRotation', 'security.columnLevelEncryptionForPii'],
  },
  {
    icon: HardDrive, title: 'security.backupRecovery', color: 'text-cyan-400',
    desc: 'security.pointInTimeRecoveryWith',
    details: ['security.continuousWalArchiving', 'security.pointInTimeRecovery', 'security.geoRedundantBackupStorage', '30-day backup retention'],
  },
];

const COMPLIANCE_BADGES = [
  {
    badge: 'SOC 2', label: 'security.soc2TypeIi', sub: 'security.auditedAnnually',
    desc: 'security.independentAuditorsVerifyOurSecurity',
  },
  {
    badge: 'GDPR', label: 'security.gdpr', sub: 'security.euCompliant',
    desc: 'security.fullComplianceWithEuGeneral',
  },
  {
    badge: 'HIPAA', label: 'security.hipaa', sub: 'security.healthcareReady',
    desc: 'security.weImplementAdministrativePhysicalAnd',
  },
  {
    badge: 'CCPA', label: 'security.ccpa', sub: 'security.californiaCompliant',
    desc: 'security.californiaResidentsHaveFullRights',
  },
];

const CONTROLS = [
  {
    icon: Users, title: 'security.granularAccessControls',
    desc: 'security.inviteFamilyMembersAndAssign',
  },
  {
    icon: Download, title: 'security.fullDataPortability',
    desc: 'Export all your family\'s data anytime in standard formats (JSON, CSV). Your data belongs to you — always.',
  },
  {
    icon: Trash2, title: 'security.instantDeletion',
    desc: 'Permanently delete individual records, a family member\'s data, or your entire account. Deletion is irreversible and includes backups within 30 days.',
  },
  {
    icon: EyeOff, title: 'security.zeroAdsZeroTracking',
    desc: 'We don\'t show ads, sell data, or track your family across the web. No third-party analytics scripts run on your dashboard.',
  },
  {
    icon: MonitorSmartphone, title: 'security.sessionManagement',
    desc: 'security.viewAllActiveSessionsSee',
  },
  {
    icon: FileText, title: 'security.auditLogs',
    desc: 'Every significant action is logged with timestamps. Review who accessed what, when, and from where in your family\'s activity log.',
  },
];

const INCIDENT_TIMELINE = [
  { phase: 'security.detection', time: 'security.5Min', desc: 'security.automatedMonitoringDetectsAnomaliesWithin', icon: Zap },
  { phase: 'security.assessment', time: 'security.30Min', desc: 'security.onCallSecurityEngineerAssesses', icon: AlertTriangle },
  { phase: 'security.notification', time: 'security.24Hrs', desc: 'security.affectedUsersAreNotifiedWithin', icon: Mail },
  { phase: 'security.resolution', time: 'security.ongoing', desc: 'security.rootCauseAnalysisRemediationAnd', icon: CheckCircle2 },
];

const DATA_RESIDENCY = [
  { region: 'security.unitedStates', location: 'US-East (Virginia)', provider: 'AWS', flag: '🇺🇸' },
  { region: 'security.europeanUnion', location: 'EU-West (Frankfurt)', provider: 'AWS', flag: '🇪🇺' },
  { region: 'security.asiaPacific', location: 'AP-Southeast (Sydney)', provider: 'AWS', flag: '🇦🇺' },
];

const SECURITY_FAQ = [
  { q: 'How is my family\'s data encrypted?', a: 'security.allDataIsEncryptedIn' },
  { q: 'security.doesBubalySellOrShare', a: 'Absolutely not. We never sell, rent, or share your family\'s data with any third party for advertising or marketing purposes. The only data sharing that occurs is what you explicitly initiate — like sharing a calendar event or photo with a family member.' },
  { q: 'security.whatHappensIfIDelete', a: 'When you delete your account, all your data is immediately removed from our production systems. Backup copies are purged within 30 days. This process is irreversible. You can also delete individual records or a specific family member\'s data without deleting your entire account.' },
  { q: 'security.isMyDataProcessedBy', a: 'Our AI features process your data only when you explicitly use them (like the AI Assistant or Smart Briefing). AI processing happens in isolated, ephemeral containers. We never use your family\'s data to train AI models. All AI interactions are logged in your audit trail for transparency.' },
  { q: 'How does Bubaly handle children\'s data?', a: 'We comply with COPPA (Children\'s Online Privacy Protection Act) and equivalent international regulations. Children\'s accounts are managed by parent accounts with restricted permissions. We collect the minimum data necessary and provide parents full visibility and control over their children\'s data.' },
  { q: 'security.whatMultiFactorAuthenticationOptions', a: 'We support TOTP-based authenticator apps (Google Authenticator, Authy, 1Password), SMS verification, and biometric authentication (Face ID, Touch ID, fingerprint) on supported devices. We recommend using an authenticator app for the strongest protection.' },
  { q: 'security.howDoYouHandleSecurity', a: 'security.weMaintainAResponsibleDisclosure' },
  { q: 'security.whereIsMyDataStored', a: 'Your data is stored in the region closest to you — US-East (Virginia), EU-West (Frankfurt), or AP-Southeast (Sydney). All regions are hosted on AWS infrastructure with SOC 2 and ISO 27001 certifications. You can see your data region in your account settings.' },
  { q: 'security.whatIsYourUptimeGuarantee', a: 'security.weMaintainA9999' },
  { q: 'security.howCanIReportA', a: 'Email security@bubaly.com with details of your concern. For responsible disclosure of vulnerabilities, include steps to reproduce and we\'ll acknowledge receipt within 24 hours. For urgent account security issues, use the "Lock Account" button in your settings for immediate protection.' },
];

const COMMITMENTS = [
  { text: 'security.weNeverSellYourData', detail: 'security.yourFamilySInformationIsNever' },
  { text: 'security.weOnlyCollectWhatWe', detail: 'security.minimalDataCollectionWithPurpose' },
  { text: 'security.weProtectYourData24', detail: 'security.automatedMonitoringAlertingAndOn' },
  { text: 'security.weGiveYouFullControl', detail: 'security.exportDeleteOrModifyYour' },
  { text: 'security.wereTransparentAboutIncidents', detail: 'security.publicPostMortemsAndProactive' },
  { text: 'security.weInvestInContinuousImprovement', detail: 'security.regularPenetrationTestsSecurityAudits' },
];

export default async function SecurityPage() {
  const t = await getTranslations();
  return (
    <PageWrap>
      {/* Hero */}
      <Container className="pb-0 pt-16 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-100 px-4 py-2 text-sm font-semibold text-violet-800 dark:border-violet-400/30 dark:bg-violet-500/10 dark:text-violet-300">
              <Shield className="h-4 w-4" />{' '}{t('security.enterpriseGradeSecurity')}</div>
            <h1 className="text-5xl font-black leading-[1.06] sm:text-6xl">
              Your family&apos;s privacy<br />
              <span className="gradient-text-violet">{t('security.isOurTopPriority')}</span>
            </h1>
            <p className="mt-6 text-lg leading-8 text-white/65">{t('security.builtWithSameStandards')}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="#architecture" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow transition hover:-translate-y-0.5">{t('security.exploreOurSecurity')}{' '}<ArrowRight className="h-4 w-4" />
              </Link>
              <Link href="#faq" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-bold transition hover:bg-white/[0.06]">{t('security.securityFaq')}</Link>
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
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.defenseInDepth')}</p>
          <h2 className="text-3xl font-black sm:text-4xl">{t('security.securityAtEveryLayer')}</h2>
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
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.trustCenter')}</p>
            <h2 className="text-3xl font-black sm:text-4xl">{t('security.certifiedCompliantTrusted')}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-white/55">{t('security.meetsAndExceeds')}</p>
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
              <span>{t('security.annualPenetrationTesting')}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-white/50">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>{t('security.continuousVulnerabilityScanning')}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-white/50">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>{t('security.bugBountyProgram')}</span>
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
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.dataSovereignty')}</p>
            <h2 className="text-3xl font-black sm:text-4xl">{t('security.yourDataYourRegion')}</h2>
            <p className="mt-4 text-white/55">
              Choose where your family&apos;s data lives. All regions run on AWS infrastructure with
              SOC 2, ISO 27001, and ISO 27018 certifications. Data never leaves your selected region
              unless you explicitly request a transfer.
            </p>
            <div className="mt-6 space-y-3">
              <div className="flex items-center gap-3 text-sm text-white/60">
                <Cloud className="h-4 w-4 text-violet-300" />
                <span>{t('security.multiAzDeploymentForHigh')}</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white/60">
                <RefreshCw className="h-4 w-4 text-violet-300" />
                <span>{t('security.automaticFailoverWithinRegion')}</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white/60">
                <Server className="h-4 w-4 text-violet-300" />
                <span>{t('security.encryptedCrossRegionBackups')}</span>
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
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.yourDataYourRules')}</p>
          <h2 className="text-3xl font-black sm:text-4xl">{t('security.youHaveFullControl')}</h2>
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
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.incidentResponse')}</p>
            <h2 className="text-3xl font-black sm:text-4xl">{t('security.whenItMattersMost')}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-white/55">{t('security.incidentProtocol')}</p>
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
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.responsibleDisclosure')}</p>
            <h2 className="text-3xl font-black sm:text-4xl">{t('security.foundAVulnerability')}</h2>
            <p className="mt-4 text-white/55">{t('security.disclosureIntro')}</p>
            <div className="mt-6 space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">24-hour acknowledgment</p>
                  <p className="text-xs text-white/50">{t('security.weConfirmReceiptOfEvery')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">48-hour triage</p>
                  <p className="text-xs text-white/50">{t('security.ourSecurityTeamAssessesSeverity')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">{t('security.safeHarborPolicy')}</p>
                  <p className="text-xs text-white/50">{t('security.researchersActingInGoodFaith')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold">{t('security.creditRecognition')}</p>
                  <p className="text-xs text-white/50">{t('security.researchersAreCreditedOnOur')}</p>
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-6 sm:p-8">
            <h3 className="text-lg font-bold">{t('security.reportAVulnerability')}</h3>
            <p className="mt-2 text-sm leading-6 text-white/55">
              Send your report to our security team. Include a detailed description, steps to reproduce,
              and potential impact. We&apos;ll work with you to understand and address the issue.
            </p>
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <Mail className="h-5 w-5 text-violet-300" />
                <div>
                  <p className="text-xs text-white/50">{t('security.email')}</p>
                  <a href="mailto:security@bubaly.com" className="text-sm font-semibold text-violet-300 hover:text-violet-200">
                    security@bubaly.com
                  </a>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <KeyRound className="h-5 w-5 text-violet-300" />
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

      {/* Our Commitment */}
      <Container className="py-20">
        <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-8 sm:p-12">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-violet-600/20">
                <Shield className="h-8 w-8 text-violet-300" />
              </div>
              <h2 className="text-3xl font-black">{t('security.ourCommitmentToYou')}</h2>
              <p className="mt-4 text-sm leading-7 text-white/65">
                We know families trust us with what matters most. That&apos;s why security isn&apos;t a feature
                we added — it&apos;s the foundation we built on. Every decision, from architecture to
                hiring, prioritizes your family&apos;s safety.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/privacy" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow">{t('security.readOurPrivacyPolicy')}{' '}<ExternalLink className="h-4 w-4" />
                </Link>
                <Link href="/terms" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-bold transition hover:bg-white/[0.06]">{t('security.termsOfService')}</Link>
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
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">{t('security.commonQuestions')}</p>
          <h2 className="text-3xl font-black sm:text-4xl">{t('security.securityFaq')}</h2>
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
              <h2 className="text-lg font-bold">{t('security.haveASecurityQuestion')}</h2>
              <p className="mt-1 text-sm text-white/55">{t('security.teamIsHereToHelp')}</p>
            </div>
            <div className="flex gap-3">
              <a href="mailto:security@bubaly.com" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold shadow-glow">
                <Mail className="h-4 w-4" />{' '}{t('security.contactSecurityTeam')}</a>
            </div>
          </div>
        </Container>
      </div>
      <MarketingAeoSection path="/security" name={t('security.bubalySecurity')} description={t('security.howBubalyProtectsFamilyData')} />
    </PageWrap>
  );
}
