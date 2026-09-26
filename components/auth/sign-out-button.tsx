'use client';

// Sign-out trigger with an "Are you sure?" confirmation step (the logout-confirm
// mockup). The trigger looks like whatever the call site passes via children +
// className. The form captures the current session when the sheet opens;
// cancelling closes the sheet without changing that session.
import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { SignOutForm } from '@/components/auth/sign-out-form';
import { useTranslations } from '@/components/i18n/locale-provider';

export function SignOutButton({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {children ?? (<><LogOut className="h-4 w-4" /> {t('signOutButton.signOut')}</>)}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('signOutButton.signOut')}
        description={t('signOutButton.youLlNeedToSign')}
      >
        <SignOutForm className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          {({ signingOut }) => (<>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={signingOut}>
              {t('signOutButton.cancel')}
            </Button>
            <Button type="submit" variant="danger" loading={signingOut}>
              <LogOut className="h-4 w-4" /> {t('signOutButton.signOut')}
            </Button>
          </>)}
        </SignOutForm>
      </Modal>
    </>
  );
}
