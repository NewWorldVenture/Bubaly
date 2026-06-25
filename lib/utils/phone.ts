export interface CountryDialCode {
  code: string;    // ISO 3166-1 alpha-2
  name: string;
  flag: string;    // emoji
  dialCode: string; // e.g. "+1"
  format: string;  // local number placeholder
}

export const COUNTRY_DIAL_CODES: CountryDialCode[] = [
  { code: 'US', name: 'United States', flag: '🇺🇸', dialCode: '+1', format: '(555) 000-0000' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦', dialCode: '+1', format: '(555) 000-0000' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', dialCode: '+44', format: '7911 000 000' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺', dialCode: '+61', format: '400 000 000' },
  { code: 'NZ', name: 'New Zealand', flag: '🇳🇿', dialCode: '+64', format: '21 000 0000' },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪', dialCode: '+353', format: '85 000 0000' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪', dialCode: '+49', format: '151 00000000' },
  { code: 'FR', name: 'France', flag: '🇫🇷', dialCode: '+33', format: '6 00 00 00 00' },
  { code: 'ES', name: 'Spain', flag: '🇪🇸', dialCode: '+34', format: '600 000 000' },
  { code: 'IT', name: 'Italy', flag: '🇮🇹', dialCode: '+39', format: '320 000 0000' },
  { code: 'NL', name: 'Netherlands', flag: '🇳🇱', dialCode: '+31', format: '6 00000000' },
  { code: 'BE', name: 'Belgium', flag: '🇧🇪', dialCode: '+32', format: '470 00 00 00' },
  { code: 'CH', name: 'Switzerland', flag: '🇨🇭', dialCode: '+41', format: '76 000 00 00' },
  { code: 'AT', name: 'Austria', flag: '🇦🇹', dialCode: '+43', format: '664 000000' },
  { code: 'PT', name: 'Portugal', flag: '🇵🇹', dialCode: '+351', format: '910 000 000' },
  { code: 'SE', name: 'Sweden', flag: '🇸🇪', dialCode: '+46', format: '70 000 00 00' },
  { code: 'NO', name: 'Norway', flag: '🇳🇴', dialCode: '+47', format: '400 00 000' },
  { code: 'DK', name: 'Denmark', flag: '🇩🇰', dialCode: '+45', format: '40 00 00 00' },
  { code: 'FI', name: 'Finland', flag: '🇫🇮', dialCode: '+358', format: '40 0000000' },
  { code: 'PL', name: 'Poland', flag: '🇵🇱', dialCode: '+48', format: '500 000 000' },
  { code: 'CZ', name: 'Czech Republic', flag: '🇨🇿', dialCode: '+420', format: '601 000 000' },
  { code: 'GR', name: 'Greece', flag: '🇬🇷', dialCode: '+30', format: '690 0000000' },
  { code: 'RO', name: 'Romania', flag: '🇷🇴', dialCode: '+40', format: '721 000 000' },
  { code: 'HU', name: 'Hungary', flag: '🇭🇺', dialCode: '+36', format: '20 000 0000' },
  { code: 'JP', name: 'Japan', flag: '🇯🇵', dialCode: '+81', format: '90 0000 0000' },
  { code: 'CN', name: 'China', flag: '🇨🇳', dialCode: '+86', format: '138 0000 0000' },
  { code: 'IN', name: 'India', flag: '🇮🇳', dialCode: '+91', format: '70000 00000' },
  { code: 'KR', name: 'South Korea', flag: '🇰🇷', dialCode: '+82', format: '10 0000 0000' },
  { code: 'SG', name: 'Singapore', flag: '🇸🇬', dialCode: '+65', format: '8000 0000' },
  { code: 'HK', name: 'Hong Kong', flag: '🇭🇰', dialCode: '+852', format: '5000 0000' },
  { code: 'TW', name: 'Taiwan', flag: '🇹🇼', dialCode: '+886', format: '912 000 000' },
  { code: 'PH', name: 'Philippines', flag: '🇵🇭', dialCode: '+63', format: '917 000 0000' },
  { code: 'TH', name: 'Thailand', flag: '🇹🇭', dialCode: '+66', format: '81 000 0000' },
  { code: 'VN', name: 'Vietnam', flag: '🇻🇳', dialCode: '+84', format: '91 000 0000' },
  { code: 'MY', name: 'Malaysia', flag: '🇲🇾', dialCode: '+60', format: '12 000 0000' },
  { code: 'ID', name: 'Indonesia', flag: '🇮🇩', dialCode: '+62', format: '812 000 0000' },
  { code: 'MX', name: 'Mexico', flag: '🇲🇽', dialCode: '+52', format: '55 0000 0000' },
  { code: 'BR', name: 'Brazil', flag: '🇧🇷', dialCode: '+55', format: '11 90000-0000' },
  { code: 'AR', name: 'Argentina', flag: '🇦🇷', dialCode: '+54', format: '11 0000-0000' },
  { code: 'CO', name: 'Colombia', flag: '🇨🇴', dialCode: '+57', format: '300 0000000' },
  { code: 'CL', name: 'Chile', flag: '🇨🇱', dialCode: '+56', format: '9 0000 0000' },
  { code: 'PE', name: 'Peru', flag: '🇵🇪', dialCode: '+51', format: '999 000 000' },
  { code: 'AE', name: 'UAE', flag: '🇦🇪', dialCode: '+971', format: '50 000 0000' },
  { code: 'SA', name: 'Saudi Arabia', flag: '🇸🇦', dialCode: '+966', format: '50 000 0000' },
  { code: 'IL', name: 'Israel', flag: '🇮🇱', dialCode: '+972', format: '50 000 0000' },
  { code: 'TR', name: 'Turkey', flag: '🇹🇷', dialCode: '+90', format: '532 000 0000' },
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦', dialCode: '+27', format: '71 000 0000' },
  { code: 'NG', name: 'Nigeria', flag: '🇳🇬', dialCode: '+234', format: '803 000 0000' },
  { code: 'KE', name: 'Kenya', flag: '🇰🇪', dialCode: '+254', format: '712 000000' },
  { code: 'EG', name: 'Egypt', flag: '🇪🇬', dialCode: '+20', format: '10 0000 0000' },
  { code: 'RU', name: 'Russia', flag: '🇷🇺', dialCode: '+7', format: '9 000 000-00-00' },
  { code: 'UA', name: 'Ukraine', flag: '🇺🇦', dialCode: '+380', format: '50 000 0000' },
];

/** Detect the user's likely country dial code from the browser locale. Falls back to +1. */
export function guessCountryDialCode(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const region = locale.includes('-') ? locale.split('-').pop()?.toUpperCase() : undefined;
    if (region) {
      const match = COUNTRY_DIAL_CODES.find((c) => c.code === region);
      if (match) return match.dialCode;
    }
  } catch { /* ignore */ }
  return '+1';
}

/** Extract the dial code from a stored E.164 phone number (+14155551234 → +1). */
export function guessDialCodeFromPhone(phone: string | null | undefined): string {
  if (!phone?.startsWith('+')) return '';
  // Match longest prefix first so +380 beats +38
  const sorted = [...COUNTRY_DIAL_CODES].sort((a, b) => b.dialCode.length - a.dialCode.length);
  for (const c of sorted) {
    if (phone.startsWith(c.dialCode)) return c.dialCode;
  }
  return '+1';
}

/** Strip the dial code prefix from an E.164 number to get the local part. */
export function extractLocalNumber(phone: string | null | undefined, dialCode: string): string {
  if (!phone) return '';
  if (dialCode && phone.startsWith(dialCode)) return phone.slice(dialCode.length);
  return phone;
}
