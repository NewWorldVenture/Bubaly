import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classFormFields } from '@/lib/school/timetable';
import { bodyOf } from './helpers/source-order';

/**
 * Editing a class on the Timetable and picking a different student said
 * "Class updated", and the class stayed on the first child.
 *
 * The edit dialog shows the Student picker filled in and changeable, but
 * `submit()` built the UPDATE from subject, teacher, room, slot, day, week and
 * school only: `member_id` was added on INSERT and never sent on UPDATE. So a
 * parent who had put Maths on Ava's timetable by mistake and moved it to Ben
 * was told it worked, Ben's week still had a free Monday morning, and the
 * planner (lib/services/school `listClasses`) kept booking around Ava instead.
 *
 * Now the add and edit paths write the same columns, built in one place.
 */

const form = {
  id: 'class-1', member_id: 'member-ben', subject: '  Maths ', teacher: ' Ms Okafor ', room: '',
  time_slot: ' 9:00-9:50 ', day_of_week: '1', week_pattern: 'a' as const, school_name: '',
};

describe('a timetable edit moves the class to the chosen student', () => {
  it('the columns a class form writes include the student it names', () => {
    expect(classFormFields(form)).toEqual({
      member_id: 'member-ben', subject: 'Maths', teacher: 'Ms Okafor', room: null,
      time_slot: '9:00-9:50', day_of_week: 1, week_pattern: 'a', school_name: null,
    });
  });

  it('a class with no weekday is written as daily, not as Sunday', () => {
    expect(classFormFields({ ...form, day_of_week: '' }).day_of_week).toBeNull();
    expect(classFormFields({ ...form, day_of_week: '0' }).day_of_week).toBe(0);
  });

  it('the edit path sends those columns, student included, not a narrower set', () => {
    const src = readFileSync('components/modules/timetable-module.tsx', 'utf8');
    const submit = bodyOf(src, 'async function submit(', "success(form.id ? 'Class updated'");
    expect(submit).toContain('const fields = classFormFields(form);');
    expect(submit).toContain(".from('school_classes').update(fields)");
    expect(submit).toContain(".from('school_classes').insert({ ...fields, family_id: familyId, created_by: userId })");
  });
});
