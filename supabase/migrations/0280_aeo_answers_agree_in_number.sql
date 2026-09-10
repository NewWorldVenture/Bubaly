-- Bubaly :: 0280 Knowledge Center answers that agree in number
-- ----------------------------------------------------------------------------
-- 0279's "what is X" frame hard-codes a singular copula, and `Reminders` is a
-- PLURAL noun phrase in all six languages -- os Lembretes, los Recordatorios,
-- i Promemoria, les Rappels, Erinnerungen, Herinneringen. So six rows read as
-- broken grammar to a native speaker: 'O que e os Lembretes?', 'I Promemoria e
-- la parte', 'Les Rappels designe'.
--
-- The root cause is the one 0279 already names for gender -- nothing should
-- have to agree with a slot -- applied to gender but missed for number. The
-- template set now declares which brand terms are plural per language and
-- supplies the frame that agrees, so `Family Travel` (plural everywhere too,
-- and only saved today by landing in a modifier position) is covered rather
-- than waiting to become the next finding. These six rows are what that
-- regeneration changes; nothing else in the 360 moved.
--
-- UPDATE rather than a re-seed, and a separate migration rather than an edit to
-- 0279, because append-only is what makes this work on a database that has
-- already applied 0279 as well as on one replaying from scratch. On a fresh
-- replay 0279 inserts the singular text moments earlier and this corrects it;
-- on a database that ran 0279 long ago it is the only thing that reaches those
-- rows at all.
--
-- The same guard 0279 uses: a row a native speaker has corrected or signed off
-- is left exactly as they left it. Publish status is deliberately NOT re-checked
-- -- the row exists because the question was published when 0279 ran, and
-- fixing its grammar should not depend on whether it is published right now.

update public.marketing_aeo_question_translations t
   set question = 'Was sind Erinnerungen?', answer = 'Erinnerungen sind der Teil des Familienlebens, der rechtzeitige Erinnerungen, damit nichts Wichtiges untergeht umfasst. Bubaly übernimmt das als KI-Betriebssystem für die Familie: Statt in Ihrem Kopf zu leben oder über Apps verstreut zu sein, wird es zu einem gemeinsamen, stets aktuellen System, das Ihre ganze Familie sehen kann. Bubalys KI-Assistent beantwortet nicht nur Fragen — er handelt und macht aus dem, was Sie sagen, echte Termine, Listen, Erinnerungen und Aufgaben.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Reminders?'
   and t.locale = 'de-DE'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = '¿Qué son los Recordatorios?', answer = 'Los Recordatorios son la parte de la vida familiar que se ocupa de avisos a tiempo para que no se escape nada importante. Bubaly se encarga de ello como sistema operativo familiar con IA: en lugar de vivir en tu cabeza o repartido entre apps, se convierte en un sistema compartido y siempre actualizado que toda tu familia puede ver. El asistente de IA de Bubaly no solo responde preguntas: actúa, y convierte lo que le pides en eventos de calendario, listas, recordatorios y tareas reales.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Reminders?'
   and t.locale = 'es-ES'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Qu’est-ce que les Rappels ?', answer = 'Les Rappels désignent la part de la vie de famille qui couvre des rappels au bon moment pour que rien d’important ne passe à la trappe. Bubaly s’en charge en tant que système d’exploitation par l’IA pour la vie de famille : au lieu de vivre dans votre tête ou d’être éparpillé entre des applications, cela devient un système partagé et toujours à jour que toute votre famille peut voir. L’assistant IA de Bubaly ne se contente pas de répondre — il agit, et transforme ce que vous demandez en véritables événements de calendrier, listes, rappels et tâches.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Reminders?'
   and t.locale = 'fr-FR'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Che cosa sono i Promemoria?', answer = 'I Promemoria sono la parte della vita familiare che si occupa di promemoria puntuali perché non sfugga nulla di importante. Bubaly se ne occupa come sistema operativo familiare con IA: invece di vivere nella tua testa o sparso tra le app, diventa un sistema condiviso e sempre aggiornato che tutta la famiglia può vedere. L’assistente IA di Bubaly non si limita a rispondere: agisce, e trasforma quello che chiedi in veri eventi di calendario, elenchi, promemoria e attività.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Reminders?'
   and t.locale = 'it-IT'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'Wat zijn Herinneringen?', answer = 'Herinneringen zijn het deel van het gezinsleven dat gaat over herinneringen op tijd zodat niets belangrijks misgaat. Bubaly regelt dat als AI-besturingssysteem voor het gezin: in plaats van in je hoofd te zitten of verspreid over apps, wordt het één gedeeld en altijd actueel systeem dat je hele gezin kan zien. De AI-assistent van Bubaly beantwoordt niet alleen vragen — hij handelt, en maakt van wat je vraagt echte agenda-afspraken, lijsten, herinneringen en taken.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Reminders?'
   and t.locale = 'nl-NL'
   and t.source = 'machine'
   and t.reviewed_at is null;

update public.marketing_aeo_question_translations t
   set question = 'O que são os Lembretes?', answer = 'Os Lembretes são a parte da vida familiar que trata de avisos na altura certa para que nada de importante escape. O Bubaly trata disso como sistema operativo familiar com IA: em vez de viver na sua cabeça ou espalhado por aplicações, passa a ser um sistema partilhado e sempre atualizado que toda a família pode ver. O assistente de IA do Bubaly não se limita a responder — age, e transforma o que pede em eventos de calendário, listas, lembretes e tarefas a sério.', updated_at = now()
  from public.marketing_aeo_questions q
 where q.id = t.question_id
   and q.question = 'What is Reminders?'
   and t.locale = 'pt-PT'
   and t.source = 'machine'
   and t.reviewed_at is null;

