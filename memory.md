# Project Memory — standing rules for agents

Durable instructions that must be honored across sessions. Read this before making changes.

## Navigation

- **DO NOT modify the global left navigation (the app sidebar) unless the user
  specifically instructs it.** This means: do not change the shared sidebar
  structure, its items/order, the expandable groups or their sub-pages, which
  accounts see it, or the `SidebarBody` / `FreeTierSidebar` / `CURATED`/nav
  constants that drive it — for ALL accounts globally — without an explicit
  request to do so.
  - The left nav is a shared, customizable surface (Settings → Navigation
    Choices). Per-user customization is fine; changing the global default or the
    component/behavior for everyone is not, unless asked.
  - Files that fall under this rule include (non-exhaustive):
    `components/app/app-shell.tsx` (SidebarBody), `components/app/free-tier-sidebar.tsx`,
    `components/app/nav-shared.tsx`, and the sidebar/nav exports in
    `lib/constants/navigation.ts` (`CURATED_*`, `PRIMARY_NAV`, `APP_NAV_GROUPS`,
    `SIDEBAR_FOOTER_NAV`, `NAV_CATALOG_*`, `DEFAULT_SIDEBAR_NAV_KEYS`).
  - If a task seems to require a global nav change, pause and confirm with the
    user first.

_Last updated: 2026-07-03._
