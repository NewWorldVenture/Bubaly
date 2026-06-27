import Link from 'next/link';

/**
 * The "By continuing, you agree to…" line shown under the auth options,
 * mirroring the consent footer on the reference sign-in screen. Links point
 * to the real legal pages.
 */
export function LegalConsent({ className }: { className?: string }) {
  return (
    <p className={className ?? 'mt-6 text-center text-xs leading-5 text-muted'}>
      By continuing, you agree to Bubaly&apos;s{' '}
      <Link href="/terms" className="font-medium text-fg underline decoration-border underline-offset-2 hover:decoration-fg">
        Terms of Service
      </Link>{' '}
      and{' '}
      <Link href="/acceptable-use" className="font-medium text-fg underline decoration-border underline-offset-2 hover:decoration-fg">
        Acceptable Use Policy
      </Link>
      , and acknowledge our{' '}
      <Link href="/privacy" className="font-medium text-fg underline decoration-border underline-offset-2 hover:decoration-fg">
        Privacy Policy
      </Link>
      .
    </p>
  );
}
