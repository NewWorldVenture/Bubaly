// iOS "Add to Home Screen" launch screens.
//
// Safari only shows a launch image when an <link rel="apple-touch-startup-image">
// media query matches the device EXACTLY (CSS width, CSS height and DPR). With no
// match it launches the installed PWA on a blank white screen until first paint,
// which reads as a broken app against Bubaly's dark theme.
//
// The PNGs are produced by scripts/generate-icons.mjs from the same device list;
// tests/mobile-ios-launch-screens.test.ts fails if the two lists drift apart or if
// a referenced file is missing from public/launch.

export type LaunchScreen = {
  /** CSS pixel width of the device in portrait. */
  width: number;
  /** CSS pixel height of the device in portrait. */
  height: number;
  /** Device pixel ratio. */
  ratio: number;
};

export const LAUNCH_SCREENS: LaunchScreen[] = [
  { width: 375, height: 667, ratio: 2 }, // SE (2nd/3rd gen), 8
  { width: 414, height: 736, ratio: 3 }, // 8 Plus
  { width: 375, height: 812, ratio: 3 }, // X, XS, 11 Pro, 12/13 mini
  { width: 414, height: 896, ratio: 2 }, // XR, 11
  { width: 414, height: 896, ratio: 3 }, // XS Max, 11 Pro Max
  { width: 390, height: 844, ratio: 3 }, // 12, 12 Pro, 13, 13 Pro, 14
  { width: 428, height: 926, ratio: 3 }, // 12/13 Pro Max, 14 Plus
  { width: 393, height: 852, ratio: 3 }, // 14 Pro, 15, 15 Pro, 16
  { width: 430, height: 932, ratio: 3 }, // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  { width: 402, height: 874, ratio: 3 }, // 16 Pro
  { width: 440, height: 956, ratio: 3 }, // 16 Pro Max
];

/** Public path of the PNG for a device, as written by scripts/generate-icons.mjs. */
export function launchScreenHref({ width, height, ratio }: LaunchScreen): string {
  return `/launch/launch-${width * ratio}x${height * ratio}.png`;
}

/** The media query Safari matches against to pick this device's launch image. */
export function launchScreenMedia({ width, height, ratio }: LaunchScreen): string {
  return `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)`;
}
