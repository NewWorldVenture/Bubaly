-- ============================================================================
-- Migration 0070: Vacation Planner — a complete family Vacation Planning OS
-- ----------------------------------------------------------------------------
-- A world-class, family-aware vacation system: trips, destinations, day-by-day
-- itineraries, flights/ground transport, lodging, activities + tickets,
-- reservations, budgets + expenses, packing, documents, emergency + medical
-- info, weather snapshots, AI recommendations, AI concierge conversations,
-- readiness (travel) scores, activity logs, notifications, and audit logs.
--
-- Every table is family-scoped (family_id NOT NULL) with is_family_member RLS,
-- has updated_at triggers, FKs with sensible cascades, and useful indexes.
-- ============================================================================

-- ---------- enums ----------
DO $$ BEGIN CREATE TYPE vacation_status AS ENUM ('planning','booked','active','completed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vacation_kind AS ENUM ('road_trip','flight','cruise','theme_park','international','domestic','staycation','camping','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_item_kind AS ENUM ('activity','reservation','meal','travel','reminder','note','free_time'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_day_part AS ENUM ('morning','afternoon','evening','all_day'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_transport_kind AS ENUM ('car','train','bus','ferry','rideshare','shuttle','subway','walk','bike','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_lodging_kind AS ENUM ('hotel','airbnb','resort','cabin','campground','cruise_cabin','hostel','family','rental','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_budget_category AS ENUM ('flights','lodging','transportation','activities','food','shopping','insurance','fees','misc'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_pack_category AS ENUM ('clothes','toiletries','electronics','medications','documents','sports','beach','ski','camping','baby','snacks','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_doc_kind AS ENUM ('passport','id','visa','ticket','boarding_pass','hotel_confirmation','rental_confirmation','insurance','itinerary','medical','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_reco_kind AS ENUM ('missing_reservation','packing','budget_warning','weather_warning','travel_conflict','activity_suggestion','restaurant','document_missing','suggestion'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_reco_status AS ENUM ('open','accepted','dismissed','done'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- core trip ----------
CREATE TABLE IF NOT EXISTS public.vacations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title           text NOT NULL,
  kind            vacation_kind NOT NULL DEFAULT 'domestic',
  status          vacation_status NOT NULL DEFAULT 'planning',
  destination     text,                         -- primary destination label
  start_date      date,
  end_date        date,
  timezone        text,
  cover_image_url text,
  description     text,
  budget_cents    bigint CHECK (budget_cents IS NULL OR budget_cents >= 0),
  currency        text NOT NULL DEFAULT 'USD',
  is_international boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacations_family ON public.vacations (family_id, start_date);
CREATE INDEX IF NOT EXISTS idx_vacations_status ON public.vacations (family_id, status);

-- ---------- who is going ----------
CREATE TABLE IF NOT EXISTS public.vacation_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id         uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  member_id           uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  role                text,                      -- adult / child / grandparent / caregiver
  guest_name          text,                      -- for non-family attendees
  dietary_restrictions text,
  accessibility_needs text,
  medical_notes       text,
  preferences         text,
  emergency_contact   text,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_vacation_members_trip ON public.vacation_members (family_id, vacation_id);

-- ---------- destinations (multi-city / cruise stops / theme parks) ----------
CREATE TABLE IF NOT EXISTS public.vacation_destinations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id   uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  region        text,
  country       text,
  latitude      double precision,
  longitude     double precision,
  arrive_date   date,
  depart_date   date,
  sort_order    integer NOT NULL DEFAULT 0,
  notes         text,
  map_url       text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_destinations_trip ON public.vacation_destinations (family_id, vacation_id, sort_order);

-- ---------- itinerary days + items ----------
CREATE TABLE IF NOT EXISTS public.vacation_itinerary_days (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id   uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  day_date      date NOT NULL,
  title         text,
  summary       text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, day_date)
);
CREATE INDEX IF NOT EXISTS idx_vacation_days_trip ON public.vacation_itinerary_days (family_id, vacation_id, day_date);

CREATE TABLE IF NOT EXISTS public.vacation_itinerary_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id   uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  day_id        uuid REFERENCES public.vacation_itinerary_days(id) ON DELETE CASCADE,
  kind          vac_item_kind NOT NULL DEFAULT 'activity',
  day_part      vac_day_part NOT NULL DEFAULT 'morning',
  title         text NOT NULL,
  location      text,
  start_time    time,
  end_time      time,
  duration_min  integer CHECK (duration_min IS NULL OR duration_min >= 0),
  cost_cents    bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  booked        boolean NOT NULL DEFAULT false,
  confirmation_code text,
  notes         text,
  member_ids    uuid[] NOT NULL DEFAULT '{}',   -- personalized itineraries
  sort_order    integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_items_trip ON public.vacation_itinerary_items (family_id, vacation_id);
CREATE INDEX IF NOT EXISTS idx_vacation_items_day ON public.vacation_itinerary_items (day_id, day_part, sort_order);

-- ---------- flights ----------
CREATE TABLE IF NOT EXISTS public.vacation_flights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  airline         text,
  flight_number   text,
  depart_airport  text,
  arrive_airport  text,
  depart_at       timestamptz,
  arrive_at       timestamptz,
  terminal        text,
  gate            text,
  seats           text,
  confirmation_code text,
  booked          boolean NOT NULL DEFAULT false,
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  document_id     uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_flights_trip ON public.vacation_flights (family_id, vacation_id, depart_at);

-- ---------- ground transportation (cars, trains, cruises legs, rideshare) ----------
CREATE TABLE IF NOT EXISTS public.vacation_transportation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            vac_transport_kind NOT NULL DEFAULT 'car',
  provider        text,                          -- rental co, rail line, cruise line
  from_location   text,
  to_location     text,
  depart_at       timestamptz,
  arrive_at       timestamptz,
  confirmation_code text,
  distance_miles  numeric(8,1) CHECK (distance_miles IS NULL OR distance_miles >= 0),
  fuel_estimate_cents bigint CHECK (fuel_estimate_cents IS NULL OR fuel_estimate_cents >= 0),
  stops           jsonb NOT NULL DEFAULT '[]',   -- road-trip stops / cruise excursions
  booked          boolean NOT NULL DEFAULT false,
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_transport_trip ON public.vacation_transportation (family_id, vacation_id, depart_at);

-- ---------- lodging ----------
CREATE TABLE IF NOT EXISTS public.vacation_lodging (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id  uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  kind            vac_lodging_kind NOT NULL DEFAULT 'hotel',
  name            text NOT NULL,
  address         text,
  phone           text,
  check_in        date,
  check_out       date,
  confirmation_code text,
  nightly_cents   bigint CHECK (nightly_cents IS NULL OR nightly_cents >= 0),
  total_cents     bigint CHECK (total_cents IS NULL OR total_cents >= 0),
  booked          boolean NOT NULL DEFAULT false,
  url             text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_lodging_trip ON public.vacation_lodging (family_id, vacation_id, check_in);

-- ---------- activities + tickets ----------
CREATE TABLE IF NOT EXISTS public.vacation_activities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id  uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  name            text NOT NULL,
  category        text,                          -- attraction / tour / restaurant / show
  location        text,
  scheduled_at    timestamptz,
  duration_min    integer CHECK (duration_min IS NULL OR duration_min >= 0),
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  family_friendly boolean NOT NULL DEFAULT true,
  url             text,
  booked          boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_activities_trip ON public.vacation_activities (family_id, vacation_id, scheduled_at);

CREATE TABLE IF NOT EXISTS public.vacation_activity_tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  activity_id     uuid REFERENCES public.vacation_activities(id) ON DELETE CASCADE,
  holder_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  holder_name     text,
  ticket_type     text,
  confirmation_code text,
  price_cents     bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  document_id     uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_tickets_trip ON public.vacation_activity_tickets (family_id, vacation_id);

-- ---------- generic reservations (dining, spa, excursions, etc.) ----------
CREATE TABLE IF NOT EXISTS public.vacation_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            text,                          -- dining / spa / tour / rental
  name            text NOT NULL,
  location        text,
  reserved_at     timestamptz,
  party_size      integer CHECK (party_size IS NULL OR party_size >= 0),
  confirmation_code text,
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  booked          boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_reservations_trip ON public.vacation_reservations (family_id, vacation_id, reserved_at);

-- ---------- budget (planned by category) + expenses (actual) ----------
CREATE TABLE IF NOT EXISTS public.vacation_budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  category        vac_budget_category NOT NULL,
  planned_cents   bigint NOT NULL DEFAULT 0 CHECK (planned_cents >= 0),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, category)
);
CREATE INDEX IF NOT EXISTS idx_vacation_budgets_trip ON public.vacation_budgets (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  category        vac_budget_category NOT NULL DEFAULT 'misc',
  description     text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  spent_on        date NOT NULL DEFAULT current_date,
  paid_by_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_expenses_trip ON public.vacation_expenses (family_id, vacation_id, spent_on);

-- ---------- packing ----------
CREATE TABLE IF NOT EXISTS public.vacation_packing_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,  -- null = master/family list
  is_master       boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_packing_lists_trip ON public.vacation_packing_lists (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_packing_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  list_id         uuid REFERENCES public.vacation_packing_lists(id) ON DELETE CASCADE,
  name            text NOT NULL,
  category        vac_pack_category NOT NULL DEFAULT 'other',
  quantity        integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  packed          boolean NOT NULL DEFAULT false,
  ai_suggested    boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_packing_items_list ON public.vacation_packing_items (family_id, vacation_id, list_id);

-- ---------- documents (travel docs; links to existing documents store) ----------
CREATE TABLE IF NOT EXISTS public.vacation_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            vac_doc_kind NOT NULL DEFAULT 'other',
  title           text NOT NULL,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  document_id     uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  file_url        text,
  number          text,                          -- passport/visa number
  issued_on       date,
  expires_on      date,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_documents_trip ON public.vacation_documents (family_id, vacation_id);

-- ---------- safety: emergency contacts + medical info ----------
CREATE TABLE IF NOT EXISTS public.vacation_emergency_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  relationship    text,
  phone           text,
  email           text,
  category        text,                          -- doctor / insurance / embassy / local_emergency
  address         text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_emergency_trip ON public.vacation_emergency_contacts (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_medical_information (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  allergies       text,
  conditions      text,
  medications     text,
  blood_type      text,
  insurance_provider text,
  insurance_number text,
  physician       text,
  physician_phone text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_medical_trip ON public.vacation_medical_information (family_id, vacation_id);

-- ---------- checklists ----------
CREATE TABLE IF NOT EXISTS public.vacation_checklists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  done            boolean NOT NULL DEFAULT false,
  due_date        date,
  assignee_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_checklists_trip ON public.vacation_checklists (family_id, vacation_id);

-- ---------- weather snapshots (real data cached from a weather provider) ----------
CREATE TABLE IF NOT EXISTS public.vacation_weather_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id  uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  location_label  text,
  latitude        double precision,
  longitude       double precision,
  forecast_date   date NOT NULL,
  temp_high_c     numeric(5,1),
  temp_low_c      numeric(5,1),
  precip_prob     integer CHECK (precip_prob IS NULL OR (precip_prob >= 0 AND precip_prob <= 100)),
  precip_mm       numeric(6,1),
  wind_kph        numeric(6,1),
  weather_code    integer,
  summary         text,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, location_label, forecast_date)
);
CREATE INDEX IF NOT EXISTS idx_vacation_weather_trip ON public.vacation_weather_snapshots (family_id, vacation_id, forecast_date);

-- ---------- AI recommendations ----------
CREATE TABLE IF NOT EXISTS public.vacation_ai_recommendations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            vac_reco_kind NOT NULL DEFAULT 'suggestion',
  status          vac_reco_status NOT NULL DEFAULT 'open',
  title           text NOT NULL,
  detail          text,
  severity        integer NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  payload         jsonb NOT NULL DEFAULT '{}',
  source          text NOT NULL DEFAULT 'rules',  -- rules | ai
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_reco_trip ON public.vacation_ai_recommendations (family_id, vacation_id, status);

-- ---------- AI concierge conversations ----------
CREATE TABLE IF NOT EXISTS public.vacation_ai_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  title           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_ai_convos_trip ON public.vacation_ai_conversations (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.vacation_ai_conversations(id) ON DELETE CASCADE,
  role            ai_role NOT NULL,
  content         text NOT NULL,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_ai_messages_convo ON public.vacation_ai_messages (family_id, conversation_id, created_at);

-- ---------- travel/readiness score history ----------
CREATE TABLE IF NOT EXISTS public.vacation_travel_scores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  score           integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  breakdown       jsonb NOT NULL DEFAULT '{}',
  computed_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_scores_trip ON public.vacation_travel_scores (family_id, vacation_id, computed_at DESC);

-- ---------- activity log + notifications + audit ----------
CREATE TABLE IF NOT EXISTS public.vacation_activity_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  actor_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  action          text NOT NULL,
  detail          text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_activity_logs_trip ON public.vacation_activity_logs (family_id, vacation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.vacation_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title           text NOT NULL,
  body            text,
  read            boolean NOT NULL DEFAULT false,
  send_at         timestamptz,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_notifications_trip ON public.vacation_notifications (family_id, vacation_id, read);

CREATE TABLE IF NOT EXISTS public.vacation_audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  table_name      text NOT NULL,
  record_id       uuid,
  action          text NOT NULL,                 -- insert / update / delete
  changes         jsonb NOT NULL DEFAULT '{}',
  actor_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_audit_trip ON public.vacation_audit_logs (family_id, vacation_id, created_at DESC);

-- ============================================================================
-- RLS + updated_at triggers, applied uniformly to every vacation table.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'vacations','vacation_members','vacation_destinations','vacation_itinerary_days',
  'vacation_itinerary_items','vacation_flights','vacation_transportation','vacation_lodging',
  'vacation_activities','vacation_activity_tickets','vacation_reservations','vacation_budgets',
  'vacation_expenses','vacation_packing_lists','vacation_packing_items','vacation_documents',
  'vacation_emergency_contacts','vacation_medical_information','vacation_checklists',
  'vacation_weather_snapshots','vacation_ai_recommendations','vacation_ai_conversations',
  'vacation_ai_messages','vacation_travel_scores','vacation_activity_logs',
  'vacation_notifications','vacation_audit_logs'
];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))',
      t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ============================================================================
-- Done! 27 family-scoped tables powering the Bubaly Vacation Planner.
-- ============================================================================
