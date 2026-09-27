# Page audit — every page, one row each

Every `page.tsx` in `app/` is one row in exactly one **lane file** here. The
roll-up in `finalaudit.md` ("Page Audit Register") is generated from these
files. Several agents (Claude sessions and Codex) work at the same time, so
the protocol below is how they stay out of each other's way.

## Protocol

```
1. git pull --rebase origin <your branch>   (and merge main if it moved)
2. pick a lane whose Claim row says FREE, or whose heartbeat is > 90 min old
3. edit ONLY that lane's Claim table: your handle, claimed_at, heartbeat, ACTIVE
4. commit just that file and push. Rejected? pull --rebase; if someone else now
   holds the lane, pick another.
5. audit the pages (below), updating each row's Status / Checked / By / Notes
6. fix what you find BEFORE marking the row — a row is FIXED only with the
   commit that fixed it named in Notes
7. node scripts/page-audit-register.mjs --write   (regenerates finalaudit.md)
8. heartbeat every ≤ 30 min; set the Claim to DONE (or FREE) when you stop
```

Never edit a lane someone else holds ACTIVE. Never hand-edit the generated
section of `finalaudit.md`; if it conflicts on rebase, take either side and
re-run step 7 — the section is a pure function of the lane files.

## Statuses

| Status | Means |
|---|---|
| `UNAUDITED` | Nobody has looked at this page yet. |
| `IN PROGRESS` | The lane holder is on it now. |
| `PASS` | Audited and working: renders for the roles that can reach it, no console or page errors, no failed same-origin requests, no raw i18n keys, no horizontal overflow at 390 px, forms and primary actions do what they say, and a refused read or write is shown as a failure rather than as an empty page or a success. |
| `FIXED` | Was broken; the fix is committed (Notes names the commit and the finding ID). |
| `OPEN` | Broken and not yet fixed; Notes names the finding ID in finalaudit.md. |
| `BLOCKED` | Cannot be audited from where you are (say why: e.g. needs a live provider key). |

## What "audited" means for a row

1. **Automated crawl** — `scripts/page-audit-crawl.mjs` visits the route
   (anonymous, then signed in as parent and as child where the route is in the
   app) and records status, redirects, console/page errors, failed requests,
   raw catalogue keys and mobile overflow. A crawl result alone is never `PASS`.
2. **Read the page** — its `page.tsx`, the module it renders and its server
   actions — for the defect classes already in `finalaudit.md`: refused reads
   rendered as empty, unconfirmed writes reported as saved, untranslated copy,
   role gates missing on screen.
3. **Record** — Status, the UTC time, your handle, and anything a reader needs
   in Notes (finding IDs, commits, what was not checked).

Dynamic routes (`[id]`) are crawled with a real id from the seeded family where
one exists; say in Notes when a route could only be exercised with a
placeholder.
