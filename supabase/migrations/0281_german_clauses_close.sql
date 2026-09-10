-- Bubaly :: 0281 Close the German clauses the frames run into
-- ----------------------------------------------------------------------------
-- German sets a subordinate clause off with a comma on BOTH sides. Two of the
-- German answer frames continue after the {blurb} slot with a finite verb --
-- "... der {blurb} umfasst." and "... lassen Sie {blurb} sich von selbst
-- erledigen." -- and six of the German vocabulary items END in a clause. Where
-- the two met, the clause was opened and never closed:
--
--   ... der rechtzeitige Erinnerungen, damit nichts Wichtiges untergeht umfasst.
--   ... lassen Sie das Planen von Reisen, an denen die ganze Familie Freude hat
--       sich von selbst erledigen.
--
-- Ten rows, all de-DE. This is the same root cause as 0280 one level up: a
-- frame that requires something of whatever lands in its slot. 0280 was number
-- agreement; this is punctuation. The templates now mark which vocabulary items
-- carry a clause and use a slot form that closes it, so the frames no longer
-- depend on what fills them.
--
-- Ten and not nine because the de-DE "What is Reminders?" row needs BOTH: 0280
-- gave it the plural copula, and its blurb is one of the clausal six. The text
-- below is the state after both corrections, so applying them in order lands
-- exactly here.
--
-- Same guard as 0279 and 0280: a row a native speaker has corrected or signed
-- off is left exactly as they left it. Publish status is deliberately not
-- re-checked -- the row exists because the question was published when 0279
-- ran, and fixing its punctuation should not depend on whether it is published
-- right now.

update public.marketing_aeo_question_translations t
   set question = 'Wie kann ich KI für Einkaufslisten nutzen?', answer = 'Der verlässliche Weg für Einkaufslisten ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie eine gemeinsame Einkaufsliste, die sich selbst aufbaut und nach Regalgang sortiert ist, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How can I use AI for grocery lists?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wie kann ich KI für Elternsein und Mental Load nutzen?', answer = 'Der verlässliche Weg für Elternsein und Mental Load ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie das Teilen der unsichtbaren Arbeit, eine Familie zu führen, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How can I use AI for parenting and mental load?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wie können große Familien Einkaufslisten mit KI vereinfachen?', answer = 'Der verlässliche Weg für Einkaufslisten ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie eine gemeinsame Einkaufsliste, die sich selbst aufbaut und nach Regalgang sortiert ist, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How can big families simplify grocery lists with AI?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wie können große Familien Elternsein und Mental Load mit KI vereinfachen?', answer = 'Der verlässliche Weg für Elternsein und Mental Load ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie das Teilen der unsichtbaren Arbeit, eine Familie zu führen, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How can big families simplify parenting and mental load with AI?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wie können Großeltern einen gemeinsamen Familienkalender mit KI vereinfachen?', answer = 'Der verlässliche Weg für einen gemeinsamen Familienkalender ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie einen Kalender, den jedes Familienmitglied sehen kann und dem alle vertrauen, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How can grandparents simplify shared family calendar with AI?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wie vereinfache ich Erinnerungen und Benachrichtigungen?', answer = 'Der verlässliche Weg für Erinnerungen und Benachrichtigungen ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie rechtzeitige Erinnerungen, damit nichts Wichtiges untergeht, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How do I simplify reminders and notifications?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wie bewältigen berufstätige Mütter Familienreisen?', answer = 'Der verlässliche Weg für Familienreisen ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie das Planen von Reisen, an denen die ganze Familie Freude hat, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How do working moms manage family travel?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wie bewältigen berufstätige Mütter Essensplanung?', answer = 'Der verlässliche Weg für Essensplanung ist, alles nicht mehr im Kopf zu behalten, sondern dafür ein gemeinsames Zuhause zu schaffen. Mit Bubaly — dem KI-Betriebssystem für die Familie — richten Sie es einmal ein und lassen das System das Erinnern übernehmen: Fragen Sie den KI-Assistenten in normaler Sprache („plane die Abendessen dieser Woche“, „trage jeden Dienstag Fußball ein“, „erinnere mich, wenn die Einverständniserklärung fällig ist“), und er legt die echten Einträge an, hält alle auf dem gleichen Stand und stupst die richtige Person zur richtigen Zeit an. Fangen Sie klein an, stellen Sie es dorthin, wo die Familie es sieht, und lassen Sie das Planen der Abendessen der Woche, während die Einkaufsliste sich selbst schreibt, sich von selbst erledigen.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'How do working moms manage meal planning?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Was ist Mental Load?', answer = 'Mental Load ist der Teil des Familienlebens, der das Teilen der unsichtbaren Arbeit, eine Familie zu führen, umfasst. Bubaly übernimmt das als KI-Betriebssystem für die Familie: Statt in Ihrem Kopf zu leben oder über Apps verstreut zu sein, wird es zu einem gemeinsamen, stets aktuellen System, das Ihre ganze Familie sehen kann. Bubalys KI-Assistent beantwortet nicht nur Fragen — er handelt und macht aus dem, was Sie sagen, echte Termine, Listen, Erinnerungen und Aufgaben.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Mental Load?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Was sind Erinnerungen?', answer = 'Erinnerungen sind der Teil des Familienlebens, der rechtzeitige Erinnerungen, damit nichts Wichtiges untergeht, umfasst. Bubaly übernimmt das als KI-Betriebssystem für die Familie: Statt in Ihrem Kopf zu leben oder über Apps verstreut zu sein, wird es zu einem gemeinsamen, stets aktuellen System, das Ihre ganze Familie sehen kann. Bubalys KI-Assistent beantwortet nicht nur Fragen — er handelt und macht aus dem, was Sie sagen, echte Termine, Listen, Erinnerungen und Aufgaben.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Reminders?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;
