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
// EVERY FIELD A PAGE RENDERS IS A CATALOGUE KEY, including the device name, the
// minimum OS and the browser. An earlier draft carried the name and the browser
// as English literals — `label: 'Any laptop, desktop or Chromebook'`,
// `browser: 'Chrome, Edge or Safari'` — and the public page printed them
// verbatim, so a French visitor read English on a page the i18n gate called
// clean. The gate scans `app/(marketing)` and `components/marketing`; copy
// parked in a data structure under `lib/` was invisible to it. The fix is not a
// better fallback, it is having no English here at all: en-US.json is the
// English, the six other catalogues are the rest, and the names that are proper
// nouns ("Google Pixel Tablet", "Safari", "Android 13") are declared identical
// in lib/i18n/messages/INVARIANT.txt so "same as English" reads as a decision
// rather than a missed translation. These two files are gated in
// scripts/i18n-scan.mjs so the blind spot cannot reopen.
//
// Pure data + pure helpers: no I/O, no React, no Supabase.

export const DEVICE_TIERS = ['recommended', 'compatible'] as const;
export type DeviceTier = (typeof DEVICE_TIERS)[number];

export type CertifiedDevice = {
  id: string;
  tier: DeviceTier;
  /** Catalogue key for the card heading — the device as its maker writes it. */
  nameKey: string;
  /** Catalogue key for the one-line description under the name. */
  noteKey: string;
  /** Catalogue key for the minimum operating system, stated as a requirement. */
  minOsKey: string;
  /** Catalogue key for the browser the display runs in on that device. */
  browserKey: string;
  /** Catalogue key for the mounting/stand/power note. */
  standNoteKey: string;
};

/** The five fields of a row that reach a reader's eyes. Every one is a key. */
export const DEVICE_COPY_FIELDS = ['nameKey', 'noteKey', 'minOsKey', 'browserKey', 'standNoteKey'] as const;

/**
 * The list, most-recommended first inside each tier.
 *
 * Deliberately short. A longer list would be a list of tablets, and a family
 * does not need Bubaly to tell them tablets exist; what they need is the four
 * or five shapes of device somebody has actually run the wall on, and an honest
 * "anything else with a current browser probably works, here is how to check".
 *
 * The browser and OS keys are shared between rows on purpose: four iPads that
 * all say Safari should say it with one string, not four that can drift apart.
 */
export const CERTIFIED_DEVICES: readonly CertifiedDevice[] = [
  {
    id: 'ipad',
    tier: 'recommended',
    nameKey: 'certifiedDevices.ipadName',
    noteKey: 'certifiedDevices.ipadNote',
    minOsKey: 'certifiedDevices.osIpad164',
    browserKey: 'certifiedDevices.browserSafari',
    standNoteKey: 'certifiedDevices.ipadStand',
  },
  {
    id: 'ipad-air',
    tier: 'recommended',
    nameKey: 'certifiedDevices.ipadAirName',
    noteKey: 'certifiedDevices.ipadAirNote',
    minOsKey: 'certifiedDevices.osIpad164',
    browserKey: 'certifiedDevices.browserSafari',
    standNoteKey: 'certifiedDevices.ipadAirStand',
  },
  {
    id: 'pixel-tablet',
    tier: 'recommended',
    nameKey: 'certifiedDevices.pixelName',
    noteKey: 'certifiedDevices.pixelNote',
    minOsKey: 'certifiedDevices.osAndroid13',
    browserKey: 'certifiedDevices.browserChrome',
    standNoteKey: 'certifiedDevices.pixelStand',
  },
  {
    id: 'galaxy-tab',
    tier: 'recommended',
    nameKey: 'certifiedDevices.galaxyName',
    noteKey: 'certifiedDevices.galaxyNote',
    minOsKey: 'certifiedDevices.osAndroid13',
    browserKey: 'certifiedDevices.browserChrome',
    standNoteKey: 'certifiedDevices.galaxyStand',
  },
  {
    id: 'older-ipad',
    tier: 'compatible',
    nameKey: 'certifiedDevices.olderIpadName',
    noteKey: 'certifiedDevices.olderIpadNote',
    minOsKey: 'certifiedDevices.osIpad15',
    browserKey: 'certifiedDevices.browserSafari',
    standNoteKey: 'certifiedDevices.olderIpadStand',
  },
  {
    id: 'fire-hd',
    tier: 'compatible',
    nameKey: 'certifiedDevices.fireName',
    noteKey: 'certifiedDevices.fireNote',
    minOsKey: 'certifiedDevices.osFire8',
    browserKey: 'certifiedDevices.browserSilk',
    standNoteKey: 'certifiedDevices.fireStand',
  },
  {
    id: 'desktop',
    tier: 'compatible',
    nameKey: 'certifiedDevices.desktopName',
    noteKey: 'certifiedDevices.desktopNote',
    minOsKey: 'certifiedDevices.osDesktop',
    browserKey: 'certifiedDevices.browserDesktop',
    standNoteKey: 'certifiedDevices.desktopStand',
  },
];

/** The steps a family follows on the device itself, in order. */
export type DeviceSetupStep = {
  id: string;
  labelKey: string;
  bodyKey: string;
};

export const DEVICE_SETUP_STEPS: readonly DeviceSetupStep[] = [
  { id: 'sign-in', labelKey: 'certifiedDevices.stepSignIn', bodyKey: 'certifiedDevices.stepSignInBody' },
  { id: 'install', labelKey: 'certifiedDevices.stepInstall', bodyKey: 'certifiedDevices.stepInstallBody' },
  { id: 'open-display', labelKey: 'certifiedDevices.stepOpen', bodyKey: 'certifiedDevices.stepOpenBody' },
  { id: 'stay-awake', labelKey: 'certifiedDevices.stepAwake', bodyKey: 'certifiedDevices.stepAwakeBody' },
  { id: 'lock-it-down', labelKey: 'certifiedDevices.stepPin', bodyKey: 'certifiedDevices.stepPinBody' },
  { id: 'mount', labelKey: 'certifiedDevices.stepMount', bodyKey: 'certifiedDevices.stepMountBody' },
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
    ...devices.flatMap((device) => DEVICE_COPY_FIELDS.map((field) => device[field])),
    ...DEVICE_SETUP_STEPS.flatMap((step) => [step.labelKey, step.bodyKey]),
  ];
}
