# Marketing Asset Provenance

This inventory is intentionally short and explicit. New images and videos must
be uploaded through the Super Admin Asset Library, carry a license/source record,
and pass the content-hash duplicate check before they can be reused.

| Asset family | Location | License/provenance | Duplicate policy |
|---|---|---|---|
| Bubaly brand mark and generated icon set | `public/brand/`, `public/icons/` | Original Bubaly-owned artwork | SHA-256 unique files; icon aliases are consolidated |
| Family lifestyle hero | `public/images/family-ai-lifestyle.png` | First-party project asset; retain source record with the project owner | SHA-256 unique |
| Supabase marketing uploads | `marketing_assets` / private `marketing-assets` bucket | `license`, `source_url`, and `attribution` are stored per asset | Active `content_hash` is unique |
| Embedded videos | `marketing_videos` | `license` is explicit; external URLs retain provider/source identity | Active `source_hash` is unique |

Run `npm run marketing:audit:assets` before publishing a marketing asset change.
The audit intentionally fails on remote raster URLs and exact duplicate bytes so
an asset cannot silently become an unlicensed or redundant dependency.
