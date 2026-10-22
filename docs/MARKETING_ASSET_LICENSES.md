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

## Reviewed local mirror of an existing blog photo

The existing **Harvested carrot** photo by **Hajia Hijjah** is mirrored at
`public/blog/harvested-carrot.jpg` to remove that article's dependency on a remote
thumbnail request. This is a reviewed exception for an existing licensed image;
it does not replace the Asset Library process for new imagery.

- Source: <https://commons.wikimedia.org/wiki/File:Harvested_carrot.jpg>
- License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Original JPEG: 2,329,664 bytes, 2992 × 2992 pixels, downloaded 2026-10-16.
- Original SHA-1: `361bf32508462dcd81a3f1bf96dae00ebb9c18dd`.
- Shipped SHA-256: `8aa9da8e302421be001d8a01a44fb020ea3bb6bef903188cab20b40a36b91c23`.
- Exact URL mapping, source URL, creator, license and byte provenance:
  `lib/blog/local-image-assets.json`.

The JPEG bytes are unchanged. Existing Next image optimization may resize or
re-encode the displayed image, and existing `object-cover` styling may crop its
display. The image and adaptations remain CC BY-SA 4.0. The article displays
creator, title, source and license links even if its editable credit is empty;
additional supplied credit remains visible. Only the exact reviewed URL maps to
this local file; unrelated image URLs keep their existing behavior.
