-- Bubaly :: 0330 - a social write needs the social permission the app checks
--
-- lib/social/roles.ts says it plainly: the permission matrix is "for most
-- permissions, the ONLY enforcement" - the social tables got plain
-- is_family_member RLS in 0034, and public.social_has_permission was consulted
-- by one policy (social_publish_jobs_insert). Every server action calls
-- requireSocialPermission first, but the tables themselves let any member -
-- a child's default social role is read_only - disconnect the family's social
-- accounts, switch off require_approval, rewrite queued posts and their
-- targets, or erase publish history and usage records, straight through the
-- API.
--
-- Each write now needs the permission its application writer already checks:
--
--   social_accounts                     connect_accounts
--   social_settings                     manage_settings
--   social_media_library                upload_media
--   social_ai_generations               generate_ai
--   social_posts, _post_variants, _post_targets, _post_assets,
--   social_campaigns, _content_templates, _schedules, _calendar_items
--       insert/delete: create_drafts, publish_posts or schedule_posts
--       (createPostAction checks the one matching its intent, and rolls back
--       what it created on failure)
--       update: publish_posts or schedule_posts (runPublishNow and the
--       schedule path are the only updaters)
--   social_publish_jobs (update/delete), social_publish_results
--                                       publish_posts or schedule_posts
--   social_usage_events                 insert: generate_ai, publish_posts or
--                                       schedule_posts; never rewritten or
--                                       deleted by a member
--   social_comments                     update: view_feed (resolveCommentAction);
--                                       rows arrive from the provider
--   social_analytics_snapshots, social_audit_logs, social_feed_items,
--   social_messages, social_provider_errors
--                                       provider/service data: member writes
--                                       dropped
--
-- Member SELECT is unchanged. The service role (scheduled publishing, token
-- storage, provider sync) bypasses RLS as before. social_reader_* (the
-- family's own news reader) and social_access_permissions (0318/0322) are not
-- touched. Pinned by docs/audit/social-write-permission-check.sql.

do $$
declare
  t text;
  p record;
  author constant text := '(public.social_has_permission(family_id, ''create_drafts'') or public.social_has_permission(family_id, ''publish_posts'') or public.social_has_permission(family_id, ''schedule_posts''))';
  sender constant text := '(public.social_has_permission(family_id, ''publish_posts'') or public.social_has_permission(family_id, ''schedule_posts''))';
  usage  constant text := '(public.social_has_permission(family_id, ''generate_ai'') or public.social_has_permission(family_id, ''publish_posts'') or public.social_has_permission(family_id, ''schedule_posts''))';
  -- table => insert, update, delete (null = no member write)
  spec text[][] := array[
    array['social_accounts',            'connect_accounts', 'connect_accounts', 'connect_accounts'],
    array['social_settings',            'manage_settings',  'manage_settings',  'manage_settings'],
    array['social_media_library',       'upload_media',     'upload_media',     'upload_media'],
    array['social_ai_generations',      'generate_ai',      'generate_ai',      'generate_ai'],
    array['social_posts',               '@author',          '@sender',          '@author'],
    array['social_post_variants',       '@author',          '@sender',          '@author'],
    array['social_post_targets',        '@author',          '@sender',          '@author'],
    array['social_post_assets',         '@author',          '@sender',          '@author'],
    array['social_campaigns',           '@author',          '@author',          '@author'],
    array['social_content_templates',   '@author',          '@author',          '@author'],
    array['social_schedules',           '@author',          '@sender',          '@author'],
    array['social_calendar_items',      '@author',          '@sender',          '@author'],
    array['social_publish_jobs',        '@sender',          '@sender',          '@sender'],
    array['social_publish_results',     '@sender',          '@sender',          '@sender'],
    array['social_usage_events',        '@usage',           null,               null],
    array['social_comments',            null,               'view_feed',        null],
    array['social_analytics_snapshots', null,               null,               null],
    array['social_audit_logs',          null,               null,               null],
    array['social_feed_items',          null,               null,               null],
    array['social_messages',            null,               null,               null],
    array['social_provider_errors',     null,               null,               null]
  ];
  i int;
  expr text;
  cmds text[] := array['insert', 'update', 'delete'];
  c int;
begin
  for i in 1 .. array_length(spec, 1) loop
    t := spec[i][1];
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and cmd <> 'SELECT' loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    for c in 1 .. 3 loop
      expr := spec[i][c + 1];
      continue when expr is null;
      expr := case expr
        when '@author' then author
        when '@sender' then sender
        when '@usage'  then usage
        else format('public.social_has_permission(family_id, %L)', expr)
      end;
      if cmds[c] = 'insert' then
        execute format('create policy %I on public.%I for insert to authenticated with check (%s)', t || '_insert', t, expr);
      elsif cmds[c] = 'update' then
        execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', t || '_update', t, expr, expr);
      else
        execute format('create policy %I on public.%I for delete to authenticated using (%s)', t || '_delete', t, expr);
      end if;
    end loop;
  end loop;
end
$$;
