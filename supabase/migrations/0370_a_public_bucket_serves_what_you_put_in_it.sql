-- Bubaly :: 0330 - the one public bucket that accepts anything
--
-- This project has four PUBLIC storage buckets. Three of them pin what may be
-- stored in them:
--
--   00890 avatars              image/jpeg,png,webp,gif,avif
--   0194  marketplace-photos   image/jpeg,png,webp,gif,avif
--   0197  feedback-attachments image/jpeg,png,webp,gif,avif
--   0216  family-media         (nothing — allowed_mime_types is NULL)
--
-- The fourth is the one that takes the widest range of user uploads: Photos,
-- Moments/Create-Memory, Inventory, Closet, Reminder attachments and Message
-- attachments, six browser upload paths, no server-side upload path at all.
--
-- 0216's header reasons carefully about READ visibility and never mentions
-- content type. So `family-media` serves whatever is put in it, from
-- `/storage/v1/object/public/…`, with no session — which makes an
-- `image/svg+xml` or `text/html` upload a page hosted on the project's own
-- Supabase domain, reachable by anyone with the link, surviving row deletion
-- and membership revocation exactly as F-E03 already records for the read path.
--
-- WHY THIS IS NOT JUST F-E03 AGAIN. F-E03 (the bucket is public) is tracked as
-- LB-009 and deferred because hardening reads to signed URLs needs a data
-- migration of every stored URL. That deferral has been covering a hole it was
-- never meant to cover: an allowlist constrains NEW UPLOADS and needs no data
-- migration at all. The expensive fix stayed parked and the cheap one was never
-- taken.
--
-- WHERE THE LIST COMES FROM. Not invented — read off the `accept` attributes of
-- the six modules that upload here, so nothing the product offers is refused:
--
--   photos-module        image/*,video/*
--   create-memory        image/*
--   inventory-module     image/*
--   closet-module        image/*
--   reminders-module     image/*
--   messages-module      application/pdf,.doc,.docx,.xls,.xlsx,.txt,image/*
--
-- `tests/a-public-bucket-allows-only-what-the-ui-offers.test.ts` ratchets that
-- correspondence, so adding a type to a file picker fails until the bucket
-- allows it — which is the direction this change could otherwise break.
--
-- HEIC/HEIF are included although no `accept` names them: `image/*` is what the
-- picker says, and an iPhone photo arrives as HEIC. Leaving them out is how an
-- allowlist breaks a real family's upload.
--
-- DELIBERATELY EXCLUDED, and this is the point of the migration:
-- `image/svg+xml`, `text/html`, `application/xhtml+xml`. No picker in this
-- product offers them, and they are the types a browser EXECUTES.
--
-- WHAT THIS DOES NOT DO: it does not make the bucket private (F-E03 stands), and
-- it does not touch objects already stored. It stops the next one.
--
-- Unlike 0216's `on conflict do nothing`, this UPDATEs — the production bucket
-- already exists, so an insert would no-op and change nothing. Audit C1-S8-10.

update storage.buckets
   set allowed_mime_types = array[
     -- images: what every picker in the product means by `image/*`
     'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
     'image/heic', 'image/heif',
     -- video: photos-module offers `video/*`
     'video/mp4', 'video/quicktime', 'video/webm',
     -- documents: messages-module's attachment picker, item for item
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'text/plain'
   ]
 where id = 'family-media';
