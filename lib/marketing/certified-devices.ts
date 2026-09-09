// lib/marketing/certified-devices.ts — the device COMPATIBILITY list behind
// the public "family display" page.
//
// Read the tier names literally. `recommended` means "this is the shape of
// device the display was designed against"; `compatible` means "this works,
// with the caveat named in its note". Neither means Bubaly has a relationship
// with the manufacturer: nobody is certified, nobody is a partner, and nobody
// paid to be on this list. `PROGRAM_DISCLAIMER_KEY` says exactly that on the
// page, because "certified devices" is a phrase families have been trained to
// read as a commercial arrangement, and here it is not one.
//
// What each row states is a REQUIREMENT, not a measurement: "iPadOS 16.4 or
// newer" is the version where Safari gained the Screen Wake Lock API, and the
// only thing that can tell a family whether their own tablet holds a wake lock
// is the "Test this display" self-check in /display/setup. Every note points
// there rather than promising behaviour this file cannot observe.
//
// Pure data + pure helpers: no I/O, no React, no Supabase.

export const DEVICE_TIERS = ['recommended', 'compatible'] as const;
export type DeviceTier = (typeof DEVICE_TIERS)[number];

export type CertifiedDevice = {
  id: string;
  tier: DeviceTier;
  /** The model as its maker writes it — a proper noun, identical in every language. */
  label: string;
  /** Catalogue key for the one-line description under the model. */
  labelKey: string;
  /** Minimum operating system, as a requirement. */
  minOs: string;
  /** The browser the display runs in on that device. */
  browser: string;
  /** Catalogue key for the mounting/stand/power note. */
  standNoteKey: string;
};

/**
 * The list, most-recommended first inside each tier.
 *
 * Deliberately short. A longer list would be a list of tablets, and a family
 * does not need Bubaly to tell them tablets exist; what they need is the four
 * or five shapes of device somebody has actually run the wall on, and an honest
 * "anything else with a current browser probably works, here is how to check".
 */
export const CERTIFIED_DEVICES: readonly CertifiedDevice[] = [
  {
    id: 'ipad',
    tier: 'recommended',
    label: 'iPad (10th generation or newer)',
    labelKey: 'certifiedDevices.ipadNote',
    minOs: 'iPadOS 16.4',
    browser: 'Safari',
    standNoteKey: 'certifiedDevices.ipadStand',
  },
  {
    id: 'ipad-air',
    tier: 'recommended',
    label: 'iPad Air / iPad Pro',
    labelKey: 'certifiedDevices.ipadAirNote',
    minOs: 'iPadOS 16.4',
    browser: 'Safari',
    standNoteKey: 'certifiedDevices.ipadAirStand',
  },
  {
    id: 'pixel-tablet',
    tier: 'recommended',
    label: 'Google Pixel Tablet',
    labelKey: 'certifiedDevices.pixelNote',
    minOs: 'Android 13',
    browser: 'Chrome',
    standNoteKey: 'certifiedDevices.pixelStand',
  },
  {
    id: 'galaxy-tab',
    tier: 'recommended',
    label: 'Samsung Galaxy Tab A9+ / Tab S',
    minOs: 'Android 13',
    labelKey: 'certifiedDevices.galaxyNote',
    browser: 'Chrome',
    standNoteKey: 'certifiedDevices.galaxyStand',
  },
  {
    id: 'older-ipad',
    tier: 'compatible',
    label: 'Older iPad (iPadOS 15)',
    labelKey: 'certifiedDevices.olderIpadNote',
    minOs: 'iPadOS 15',
    browser: 'Safari',
    standNoteKey: 'certifiedDevices.olderIpadStand',
  },
  {
    id: 'fire-hd',
    tier: 'compatible',
    label: 'Amazon Fire HD 10',
    labelKey: 'certifiedDevices.fireNote',
    minOs: 'Fire OS 8',
    browser: 'Silk',
    standNoteKey: 'certifiedDevices.fireStand',
  },
  {
    id: 'desktop',
    tier: 'compatible',
    label: 'Any laptop, desktop or Chromebook',
    labelKey: 'certifiedDevices.desktopNote',
    minOs: 'Chrome 84 / Edge 84 / Safari 16.4',
    browser: 'Chrome, Edge or Safari',
    standNoteKey: 'certifiedDevices.desktopStand',
  },
];

/** The steps a family follows on the device itself, in order. */
export type DeviceSetupStep = {
  id: string;
  /** English label — mirrored by `labelKey` for every locale. */
  label: string;
  labelKey: string;
  bodyKey: string;
};

export const DEVICE_SETUP_STEPS: readonly DeviceSetupStep[] = [
  { id: 'sign-in', label: 'Sign in on the tablet', labelKey: 'certifiedDevices.stepSignIn', bodyKey: 'certifiedDevices.stepSignInBody' },
  { id: 'install', label: 'Add Bubaly to the home screen', labelKey: 'certifiedDevices.stepInstall', bodyKey: 'certifiedDevices.stepInstallBody' },
  { id: 'open-display', label: 'Open the display and go full screen', labelKey: 'certifiedDevices.stepOpen', bodyKey: 'certifiedDevices.stepOpenBody' },
  { id: 'stay-awake', label: 'Keep the screen awake', labelKey: 'certifiedDevices.stepAwake', bodyKey: 'certifiedDevices.stepAwakeBody' },
  { id: 'lock-it-down', label: 'Lock it to the one app', labelKey: 'certifiedDevices.stepPin', bodyKey: 'certifiedDevices.stepPinBody' },
  { id: 'mount', label: 'Stand it up and plug it in', labelKey: 'certifiedDevices.stepMount', bodyKey: 'certifiedDevices.stepMountBody' },
];

/** The sentence that keeps the tier names from reading as a commercial claim. */
export const PROGRAM_DISCLAIMER_KEY = 'certifiedDevices.disclaimer';

/** The devices in one tier, in list order. Pure. */
export function devicesInTier(tier: DeviceTier, devices: readonly CertifiedDevice[] = CERTIFIED_DEVICES): CertifiedDevice[] {
  return devices.filter((device) => device.tier === tier);
}

/** Every catalogue key this module asks a page to render. Used by the i18n test. */
export function deviceCopyKeys(devices: readonly CertifiedDevice[] = CERTIFIED_DEVICES): string[] {
  return [
    PROGRAM_DISCLAIMER_KEY,
    ...devices.flatMap((device) => [device.labelKey, device.standNoteKey]),
    ...DEVICE_SETUP_STEPS.flatMap((step) => [step.labelKey, step.bodyKey]),
  ];
}
