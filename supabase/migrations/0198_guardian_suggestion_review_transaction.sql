-- Bubaly :: 0198 - atomic Guardian suggestion review
--
-- A suggestion review changes both the human-review state and, for approved
-- suggestions, the trust graph or routing rules. Keep those writes and the
-- compliance audit entry in one manager-authorized transaction.

create or replace function public.guardian_review_suggestion(
  p_suggestion_id uuid,
  p_decision text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_suggestion record;
  v_rule jsonb;
  v_priority integer;
  v_action public.guardian_routing_mode;
  v_trust_levels text[];
  v_time_start time;
  v_time_end time;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_decision not in ('approved', 'dismissed') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_decision');
  end if;

  select * into v_suggestion
    from public.guardian_suggestions
   where id = p_suggestion_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not public.can_manage_family(v_suggestion.family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_suggestion.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_reviewed');
  end if;

  if p_decision = 'approved' then
    -- Trust-changing suggestions update the contact before the suggestion is
    -- marked approved. A missing contact rolls back the entire review.
    if v_suggestion.suggestion_type in ('update_trust', 'block_contact')
       and v_suggestion.proposed_contact_id is not null
       and v_suggestion.proposed_trust_level is not null then
      update public.guardian_contacts
         set trust_level = v_suggestion.proposed_trust_level,
             trust_override = true
       where id = v_suggestion.proposed_contact_id
         and family_id = v_suggestion.family_id;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'contact_not_found');
      end if;
    end if;

    if v_suggestion.suggestion_type = 'new_rule' then
      v_rule := coalesce(v_suggestion.proposed_rule_data, '{}'::jsonb);
      v_priority := case
        when (v_rule->>'priority') ~ '^[0-9]+$'
          then least((v_rule->>'priority')::numeric, 100000)::integer
        else 100
      end;
      v_action := case v_rule->>'action_routing_mode'
        when 'immediate_ring' then 'immediate_ring'::public.guardian_routing_mode
        when 'immediate_ai_summary' then 'immediate_ai_summary'::public.guardian_routing_mode
        when 'voicemail_first' then 'voicemail_first'::public.guardian_routing_mode
        when 'silent_handling' then 'silent_handling'::public.guardian_routing_mode
        when 'blocked' then 'blocked'::public.guardian_routing_mode
        else 'ai_handle_first'::public.guardian_routing_mode
      end;
      if jsonb_typeof(v_rule->'condition_trust_levels') = 'array' then
        v_trust_levels := array(
          select jsonb_array_elements_text(v_rule->'condition_trust_levels')
        );
      end if;
      if (v_rule->>'condition_time_start') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
        v_time_start := (v_rule->>'condition_time_start')::time;
      end if;
      if (v_rule->>'condition_time_end') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
        v_time_end := (v_rule->>'condition_time_end')::time;
      end if;

      insert into public.guardian_routing_rules
        (family_id, name, description, priority, is_active,
         condition_trust_levels, condition_time_start, condition_time_end,
         action_routing_mode, created_by, ai_suggested, approved_by, approved_at)
      values
        (v_suggestion.family_id,
         left(coalesce(nullif(trim(v_rule->>'name'), ''), 'Suggested Guardian rule'), 200),
         left(nullif(trim(v_rule->>'description'), ''), 2000),
         v_priority,
         case when (v_rule->>'is_active') in ('true', 'false')
           then (v_rule->>'is_active')::boolean
           else true
         end,
         v_trust_levels, v_time_start, v_time_end, v_action,
         auth.uid(), true, auth.uid(), now());
    end if;
  end if;

  update public.guardian_suggestions
     set status = p_decision,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = left(nullif(trim(coalesce(p_note, '')), ''), 2000)
   where id = v_suggestion.id;

  insert into public.guardian_audit_log
    (family_id, actor_user_id, actor, action, entity_type, entity_id, detail)
  values
    (v_suggestion.family_id, auth.uid(), 'parent',
     'suggestion.' || p_decision, 'guardian_suggestions', v_suggestion.id,
     jsonb_build_object('suggestion_type', v_suggestion.suggestion_type));

  return jsonb_build_object('ok', true, 'status', p_decision);
end;
$$;

revoke all on function public.guardian_review_suggestion(uuid, text, text) from public;
grant execute on function public.guardian_review_suggestion(uuid, text, text) to authenticated;
