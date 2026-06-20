-- Conversation participants by family_member id.
--
-- member_ids stores auth user_ids (used for read/access logic). That excludes
-- family members without a login (young kids, guests). participant_ids is the
-- canonical roster keyed by family_members.id, so account-less members are
-- first-class participants for display and membership.

alter table public.family_conversations
  add column if not exists participant_ids uuid[] not null default '{}';
