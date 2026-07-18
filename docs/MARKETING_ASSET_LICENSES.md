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
| Public blog hero images | `blog_posts.hero_image_url` | `hero_image_license`, `hero_image_source_url`, and `hero_image_attribution` are trigger-populated from the declared credit | Active source URL and source hash are unique (migration `0232`) |

Run `npm run marketing:audit:assets` before publishing a shipped asset change and
run `npm run marketing:verify:assets:remote` before publishing any Supabase-backed
marketing image or video change. Blog hero-image writes with missing attribution,
unknown licenses, non-HTTPS URLs, or duplicate sources are rejected by the
`0238_blog_image_provenance.sql` trigger/index contract.
The audit intentionally fails on remote raster URLs and exact duplicate bytes so
an asset cannot silently become an unlicensed or redundant dependency.
