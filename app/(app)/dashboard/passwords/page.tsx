import type { Metadata } from 'next';
import { PasswordsModule } from '@/components/modules/passwords-module';

export const metadata: Metadata = { title: 'Wi-Fi & Passwords' };

export default function PasswordsPage() {
  return <PasswordsModule />;
}
