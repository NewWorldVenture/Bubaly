# A11Y-001 — Screen-reader pass (Orca on Chromium)

Date: 2026-10-26. Builds: local production builds of main `8a95fee` (first pass) and of #1123 on main `ffce3e7` (the phone form re-check and the form flows). Root owns the master audit status.

## Setup

A real screen reader, not an accessibility-tree dump:

- **Orca 46.1** (Ubuntu noble), run under Python 3.12 with `--debug-file`. Every utterance Orca sends to speech is logged as `SPEECH OUTPUT: '…'`.
- **Chromium (Chrome for Testing)**, headed on Xvfb, with `--force-renderer-accessibility`. It talks to Orca over AT-SPI, on a session D-Bus with `at-spi-bus-launcher`.
- **Driving:** Playwright, by keyboard only (Tab, Enter, Escape, typing). Each action is timestamped, and Orca's log is sliced by those timestamps, so every line below is what Orca spoke in answer to that action.
- **Data:** a seeded local household; the account is a super admin.

## What Orca said

| Flow and action | Orca |
|---|---|
| Log-in page loads | "Finished loading Log in · Bubaly." "Page has 3 landmarks, 1 heading, 1 form, 8 unvisited links." |
| Tab through log-in | "Bubaly home link." "Switch to light mode push button." "Continue with phone push button." "Continue with Google push button." "Email entry you@example.com required." "Password password text." |
| Enter with a wrong password | "Could not sign in" |
| Theme switch, Enter | "Switch to light mode push button." then "Switch to dark mode" |
| Signed in, page loads | "Admin Dashboard" (route announcement), then "Finished loading Home · Bubaly." |
| Tab through the app shell | "Skip to content link." "Bubaly home link." "AI Assistant link." "Home link." "Calendar link." "Tasks link." "Meals link." "Expand Meals collapsed push button." "Chores link." "Finances link." |
| Calendar page loads | "Finished loading Calendar · Bubaly." "Page has 6 landmarks, 1 heading, 28 unvisited links." |
| Add Event, Enter | "Add Event push button." then "Close dialog push button." (focus is inside the dialog) |
| Tab through the dialog | "Title entry Team dinner required." "Category combo box. General. opens menu" "Starts Month Starts … spin button." |
| Submit with the title and start empty | "Title is required" "Pick a start time" |
| Back to Title | "Title entry Team dinner required. invalid entry. Title is required." |
| Escape | "Add Event push button." (focus back on the button that opened it) |
| Save with title and start set | "Saving..." then "Add Event push button." (the dialog closes and focus returns) |
| Admin team page loads | "Finished loading Admin Management · Bubaly." "Page has 4 landmarks, 4 headings, 2 forms, 1 table, 41 unvisited links." |
| More actions (#1120): focus, Enter, Tab, Escape | "More actions collapsed push button." "expanded" "Activate push button." "collapsed" |
| Country picker: focus, Enter | "Country: United States collapsed push button. opens listbox" then "expanded" "Search country or code… entry." |
| Type "Germ", Tab, Enter | "🇩🇪 Germany +49. not selected." then "collapsed" (focus back on the button) |
| Continue with phone, Enter (after #1123) | "Phone number entry (555) 000-0000." |
| Back, Enter (after #1123) | "Continue with phone push button." |

## Findings

1. **Fixed in #1123.** Continue with phone left focus on the page itself. Before #1123, Orca said "Log in · Bubaly document web" and nothing about the form that had replaced the button. Back did the same in reverse, and sign-up's two buttons that open the phone form did the same. The form now focuses its number field, and Back returns focus to the button that opened it.
   The same PR fixes a race its CI found in the country picker, which this pass also drove: opening it focused the search field 40 ms late, so a person who had already moved to an option was pulled back to the search field, and their Enter did nothing. The search field now takes focus as the list opens. On review, the owner found the phone form faded in while its number field already had focus, its text at 2.0 to 3.25:1 100 ms in; it now appears at full strength.
2. **Not this app.** Entering a dialog, Orca spoke the focused control but not the dialog's name. A minimal, textbook `role="dialog"` with `aria-modal="true"` and `aria-labelledby` behaved the same in this setup ("Close push button." only), so it is how Orca presents a web dialog here.
3. **Observed, not a WCAG failure.** Submitting the Add Event form a second time with an error unchanged ("Pick a start time") produced no speech: the error text did not change, so its live region stayed quiet, and focus stays on the button. The error is in text and tied to its field (3.3.1), and Orca reads it on the field. Moving focus to the first invalid field on a failed submit would help; no form in the app does that yet.

## Not covered

- Physical devices.
- The screen readers people mostly use on them: VoiceOver (iOS, macOS), TalkBack (Android), NVDA and JAWS (Windows).
- Orca on Chromium on Linux is a real screen reader, but not those.
