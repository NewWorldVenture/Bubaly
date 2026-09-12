import { cookies } from 'next/headers';
import { decodeSignOutBridge, SIGNOUT_BRIDGE_COOKIE } from '@/lib/auth/signout-bridge';
import { SignOutCompletion } from '@/components/auth/sign-out-completion';

export default async function SignOutCompletionPage({ searchParams }: { searchParams: Promise<{ intent?: string | string[] }> }) {
  const params = await searchParams;
  const bridge = decodeSignOutBridge((await cookies()).get(SIGNOUT_BRIDGE_COOKIE)?.value,
    typeof params.intent === 'string' ? params.intent : undefined);
  return <SignOutCompletion bridge={bridge} />;
}
