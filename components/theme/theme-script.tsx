// Runs before paint to apply the saved theme — prevents a flash of the wrong theme.
// Dark is the product default; 'system' follows the OS, 'light' is the user toggle.
const script = `
(function () {
  try {
    var stored = localStorage.getItem('familyos-theme') || 'dark';
    var system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    var resolved = stored === 'system' ? system : stored;
    var root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(resolved);
    root.style.colorScheme = resolved;
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} suppressHydrationWarning />;
}
