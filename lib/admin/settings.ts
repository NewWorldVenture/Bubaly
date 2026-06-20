// Admin settings shape + defaults. Plain module (NOT 'use server') so the
// constant can be imported by client components and server actions alike.

export type AdminSettings = {
  platformName: string;
  tagline: string;
  timezone: string;
  dateFormat: string;
  timeFormat: '12h' | '24h';
  weekStartsOn: 'Sunday' | 'Monday';
  maintenanceMode: boolean;
  passwordPolicy: 'Basic' | 'Medium' | 'Strong';
  sessionTimeoutMins: number;
  failedLoginLimit: number;
  twoFactor: boolean;
  ipWhitelisting: boolean;
  notifyNewUser: boolean;
  notifySubscription: boolean;
  notifyPayment: boolean;
  notifySecurity: boolean;
  notifySystem: boolean;
  storageLimitTB: number;
  dataRetentionYears: number;
  autoDeleteInactive: boolean;
  backupFrequency: 'Hourly' | 'Daily' | 'Weekly';
};

export const DEFAULT_SETTINGS: AdminSettings = {
  platformName: 'FamilyOS',
  tagline: 'A smarter way to manage your family',
  timezone: 'America/New_York',
  dateFormat: 'MMM DD, YYYY',
  timeFormat: '12h',
  weekStartsOn: 'Sunday',
  maintenanceMode: false,
  passwordPolicy: 'Strong',
  sessionTimeoutMins: 30,
  failedLoginLimit: 5,
  twoFactor: true,
  ipWhitelisting: false,
  notifyNewUser: true,
  notifySubscription: true,
  notifyPayment: true,
  notifySecurity: true,
  notifySystem: false,
  storageLimitTB: 10,
  dataRetentionYears: 2,
  autoDeleteInactive: false,
  backupFrequency: 'Daily',
};
