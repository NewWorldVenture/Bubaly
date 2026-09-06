-- Synthetic minimal physical schema, NOT the full legacy migration chain.
-- Mirrors required columns from 0006, 0110, 0113, 0250 and 0256.
-- The workflow applies actual 0272 after this file. Main E2E owns full-chain coverage.
DO $$
BEGIN
  IF current_database() <> 'bubaly_finance_operation_ci'
     OR current_user <> 'postgres' OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0272 bootstrap requires its dedicated synthetic PostgreSQL 17 database';
  END IF;
END $$;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.families (id uuid PRIMARY KEY);
CREATE TABLE public.family_members (
  id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE
);
CREATE TABLE public.financial_accounts (
  id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE
);
CREATE TABLE public.documents (
  id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE
);
CREATE TYPE public.transaction_type AS ENUM ('income', 'expense', 'transfer');
CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  category text,
  date date NOT NULL DEFAULT CURRENT_DATE,
  type public.transaction_type NOT NULL DEFAULT 'expense',
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'posted'
    CHECK (status IN ('posted', 'pending', 'cleared', 'failed', 'scheduled')),
  merchant text,
  fingerprint text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'receipt', 'import', 'ai')),
  receipt_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_transactions_fingerprint ON public.transactions(family_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
CREATE TABLE public.ai_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('ai', 'member', 'system')),
  inputs jsonb NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'succeeded', 'failed')),
  attempt integer NOT NULL DEFAULT 1,
  locked_at timestamptz,
  finished_at timestamptz,
  outputs jsonb,
  idempotency_key text NOT NULL,
  UNIQUE (family_id, idempotency_key)
);
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT SELECT ON public.ai_tool_calls, public.financial_accounts, public.family_members, public.documents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO service_role;
