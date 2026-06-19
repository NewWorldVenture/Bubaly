import { Resend } from 'resend';

let resendClient: Resend | null = null;

export function getResend(): Resend {
  resendClient ??= new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export const FROM_EMAIL = 'FamilyOS <hello@familyos.app>';
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://familyos.vercel.app';
