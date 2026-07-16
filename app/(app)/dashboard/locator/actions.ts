'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { placeForPoint, classifyTransition, type PlaceLike } from '@/lib/location/geo';

export type LocationResult = { ok: boolean; error?: string; place?: string | null };

/**
 * Records the caller's current position, evaluates it against the family's saved
 * geofences, logs arrival/departure events on transitions, and notifies the rest
 * of the family. Strictly self-only — a member can only post their own location.
 */
export async function updateMyLocation(input: {
  latitude: number; longitude: number; accuracy?: number | null; battery?: number | null;
}): Promise<LocationResult> {
  const c = await requireUserContext();
  const familyId = c.active.familyId;
  const member = c.active.member;
  if (!member) return { ok: false, error: 'No family member profile.' };
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    return { ok: false, error: 'Invalid coordinates.' };
  }
  const supabase = await createServer();
  const point = { latitude: input.latitude, longitude: input.longitude };

  const { data: places } = await supabase
    .from('family_places').select('id, name, latitude, longitude, radius_m').eq('family_id', familyId);
  const placeLikes: PlaceLike[] = (places ?? []).map((p) => ({
    id: p.id, name: p.name, latitude: p.latitude, longitude: p.longitude, radius_m: p.radius_m,
  }));
  const current = placeForPoint(placeLikes, point);

  const { data: prev } = await supabase
    .from('member_locations').select('place_id').eq('member_id', member.id).maybeSingle();
  const prevPlaceId = prev?.place_id ?? null;

  const nowIso = new Date().toISOString();
  const { error: upErr } = await supabase.from('member_locations').upsert({
    family_id: familyId, member_id: member.id,
    latitude: input.latitude, longitude: input.longitude,
    accuracy_m: input.accuracy ?? null, battery: input.battery ?? null,
    place_id: current?.id ?? null, is_sharing: true,
  }, { onConflict: 'member_id' });
  if (upErr) return { ok: false, error: upErr.message };

  const transition = classifyTransition(prevPlaceId, current?.id ?? null);
  if (transition !== 'none') {
    const oldName = (places ?? []).find((p) => p.id === prevPlaceId)?.name ?? null;
    const events: { event_type: 'arrived' | 'left'; place_id: string | null; place_name: string | null }[] = [];
    if (transition === 'arrived' || transition === 'moved') events.push({ event_type: 'arrived', place_id: current!.id, place_name: current!.name });
    if (transition === 'left' || transition === 'moved') events.push({ event_type: 'left', place_id: prevPlaceId, place_name: oldName });

    if (events.length) {
      // Secondary to the location upsert (already persisted) — but a dropped
      // arrival/departure event silently loses the safety timeline, so log it.
      const { error: evErr } = await supabase.from('location_events').insert(events.map((e) => ({
        family_id: familyId, member_id: member.id, place_id: e.place_id, place_name: e.place_name,
        event_type: e.event_type, latitude: input.latitude, longitude: input.longitude, occurred_at: nowIso,
      })));
      if (evErr) console.error('[locator] location_events insert failed', { familyId, memberId: member.id, error: evErr });
    }

    // Place alerts → notify the rest of the family.
    const { data: members } = await supabase
      .from('family_members').select('id, user_id').eq('family_id', familyId).eq('is_active', true);
    const recipients = (members ?? []).filter((m) => m.id !== member.id && m.user_id);
    if (recipients.length) {
      const verb = transition === 'left' ? 'left' : 'arrived at';
      const placeName = transition === 'left' ? (oldName ?? 'a place') : current!.name;
      // Best-effort family alert — log a failure so a silently dropped place
      // notification (a safety signal) is observable rather than invisible.
      const { error: notifyErr } = await supabase.from('notifications').insert(recipients.map((r) => ({
        family_id: familyId, user_id: r.user_id, type: 'system' as const,
        title: `${member.display_name} ${verb} ${placeName}`, body: null,
        related_type: 'location_events', related_id: null,
      })));
      if (notifyErr) console.error('[locator] place-alert notifications insert failed', { familyId, error: notifyErr });
    }
  }

  revalidatePath('/dashboard/locator');
  return { ok: true, place: current?.name ?? null };
}

/** Toggles whether the caller shares their location. Disabling clears coordinates. */
export async function setLocationSharing(enabled: boolean): Promise<LocationResult> {
  const c = await requireUserContext();
  const member = c.active.member;
  if (!member) return { ok: false, error: 'No family member profile.' };
  const supabase = await createServer();
  const { error } = await supabase.from('member_locations').upsert({
    family_id: c.active.familyId, member_id: member.id, is_sharing: enabled,
    ...(enabled ? {} : { latitude: null, longitude: null, place_id: null }),
  }, { onConflict: 'member_id' });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/locator');
  return { ok: true };
}

export async function savePlace(input: {
  id?: string; name: string; icon?: string | null; address?: string | null;
  latitude: number; longitude: number; radius_m?: number;
}): Promise<LocationResult> {
  const c = await requireUserContext();
  if (!input.name?.trim()) return { ok: false, error: 'Name is required.' };
  const supabase = await createServer();
  const fields = {
    name: input.name.trim(), icon: input.icon ?? null, address: input.address ?? null,
    latitude: input.latitude, longitude: input.longitude, radius_m: input.radius_m ?? 150,
  };
  const { error } = input.id
    ? await supabase.from('family_places').update(fields).eq('id', input.id).eq('family_id', c.active.familyId)
    : await supabase.from('family_places').insert({ ...fields, family_id: c.active.familyId, created_by: c.user.id });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/locator');
  return { ok: true };
}

export async function deletePlace(id: string): Promise<LocationResult> {
  const c = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('family_places').delete().eq('id', id).eq('family_id', c.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/locator');
  return { ok: true };
}

/** Toggle a place's geofence on/off (drives the Geofences rail switches). */
export async function setGeofenceEnabled(id: string, enabled: boolean): Promise<LocationResult> {
  const c = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('family_places')
    .update({ geofence_enabled: enabled }).eq('id', id).eq('family_id', c.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/locator');
  return { ok: true };
}
