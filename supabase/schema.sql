-- ═══════════════════════════════════════════════
-- F2F — Supabase schema v2: services, append-only data, audit
-- Run in: Supabase Dashboard → SQL Editor
--
-- De-identified by design: Study IDs only, NO PHI.
--
-- Design notes:
--  * Collectors sign in ANONYMOUSLY and redeem a service access code.
--    No email, no password reset, no deliverability dependency — that is
--    the whole point, because friction is what stops residents using this.
--  * Nothing is ever updated or deleted. Corrections insert a new row
--    that supersedes the old one; voiding is an admin-only RPC. There is
--    deliberately no UPDATE or DELETE policy on the data tables, so
--    Postgres refuses rather than the app trusting itself.
--  * This file is idempotent — safe to re-run.
--
-- PREREQUISITE: enable Anonymous sign-ins in
--   Dashboard → Authentication → Sign In / Providers → Anonymous
-- ═══════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ═══════════════════════════════════════════════
-- 1. SERVICES + ROSTER
-- ═══════════════════════════════════════════════

-- One row per independent surgical service rotation (e.g. Dr. Castrellon).
create table if not exists public.services (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,                -- "Dr. Castrellon"
  slug             text not null unique,         -- "castrellon"
  hospital_id      text,                         -- LCH / PGH / DMC / NLN / OTH
  hospital_name    text,
  access_code_hash text not null,                -- bcrypt; never store the plaintext
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Who is on a service. Soft identity: a name, not an account.
create table if not exists public.service_members (
  id           uuid primary key default gen_random_uuid(),
  service_id   uuid not null references public.services on delete cascade,
  display_name text not null,
  role         text not null default 'resident',  -- attending | resident | other
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (service_id, display_name)
);

create index if not exists service_members_service_idx
  on public.service_members (service_id) where active;

-- ═══════════════════════════════════════════════
-- 2. PROFILES — extends the v1 table
-- ═══════════════════════════════════════════════
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  full_name  text,
  email      text,
  specialty  text,
  created_at timestamptz default now()
);

alter table public.profiles add column if not exists role       text not null default 'collector'; -- collector | admin
alter table public.profiles add column if not exists service_id uuid references public.services on delete set null;
alter table public.profiles add column if not exists member_id  uuid references public.service_members on delete set null;

-- ═══════════════════════════════════════════════
-- 3. ASSESSMENTS — extends the v1 table
-- ═══════════════════════════════════════════════
create table if not exists public.assessments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  study_id        text,
  hospital        text,
  hospital_id     text,
  enrollment_date date,
  assessment_type text,
  answers         jsonb,
  domain_scores   jsonb,
  score           int,
  tier_id         text,
  tier_label      text,
  created_at      timestamptz default now()
);

alter table public.assessments add column if not exists service_id           uuid references public.services on delete restrict;
alter table public.assessments add column if not exists entered_by_member_id uuid references public.service_members on delete set null;
alter table public.assessments add column if not exists entered_by_name      text;
alter table public.assessments add column if not exists flagged              boolean default false;
alter table public.assessments add column if not exists flag_ids             jsonb;
alter table public.assessments add column if not exists supersedes_id        uuid references public.assessments on delete set null;
alter table public.assessments add column if not exists void_reason          text;
alter table public.assessments add column if not exists voided_at            timestamptz;
alter table public.assessments add column if not exists voided_by            uuid references auth.users on delete set null;

create index if not exists assessments_service_idx on public.assessments (service_id, created_at desc);
create index if not exists assessments_study_idx   on public.assessments (study_id);
create index if not exists assessments_user_idx    on public.assessments (user_id, created_at desc);

-- ═══════════════════════════════════════════════
-- 4. OUTCOMES — 30-day endpoints (blinded entry)
-- Mirrors the app's in-memory outcome record exactly, so
-- Pedro's outcomes module needs no reshaping.
-- ═══════════════════════════════════════════════
create table if not exists public.outcomes (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users on delete cascade,
  service_id           uuid references public.services on delete restrict,
  study_id             text not null,
  outcomes             jsonb not null default '{}'::jsonb,  -- {cfl,pfl,ssi,hem,deh,ana,mort}
  clavien_dindo        text,
  cd_option            text,
  notes                text,
  any_event            boolean,
  entered_by_member_id uuid references public.service_members on delete set null,
  entered_by_name      text,
  supersedes_id        uuid references public.outcomes on delete set null,
  void_reason          text,
  voided_at            timestamptz,
  voided_by            uuid references auth.users on delete set null,
  recorded_at          timestamptz not null default now()
);

create index if not exists outcomes_service_idx on public.outcomes (service_id, recorded_at desc);
create index if not exists outcomes_study_idx   on public.outcomes (study_id);

-- ═══════════════════════════════════════════════
-- 5. AUDIT LOG — append-only
-- ═══════════════════════════════════════════════
create table if not exists public.audit_log (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  actor_user_id uuid,
  actor_name    text,
  service_id    uuid,
  action        text not null,   -- redeem_code | redeem_failed | create_assessment | ...
  entity        text,
  entity_id     uuid,
  study_id      text,
  detail        jsonb
);

create index if not exists audit_log_at_idx      on public.audit_log (at desc);
create index if not exists audit_log_service_idx on public.audit_log (service_id, at desc);

-- ═══════════════════════════════════════════════
-- 6. HELPERS
-- SECURITY DEFINER so they bypass RLS internally — without that,
-- a profiles policy calling is_admin() would recurse forever.
-- ═══════════════════════════════════════════════
create or replace function public.current_service_id()
returns uuid language sql stable security definer set search_path = public as $$
  select service_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.actor_label()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select sm.display_name from public.profiles p
       join public.service_members sm on sm.id = p.member_id
      where p.id = auth.uid()),
    (select coalesce(full_name, email) from public.profiles where id = auth.uid()),
    'unknown');
$$;

-- ═══════════════════════════════════════════════
-- 7. CURRENT VIEWS
-- A row is "current" when it is not voided and nothing supersedes it.
-- Computed, never stored — which is what keeps the tables append-only.
-- ═══════════════════════════════════════════════
create or replace view public.assessments_current as
  select a.* from public.assessments a
   where a.voided_at is null
     and not exists (
       select 1 from public.assessments b
        where b.supersedes_id = a.id and b.voided_at is null);

create or replace view public.outcomes_current as
  select o.* from public.outcomes o
   where o.voided_at is null
     and not exists (
       select 1 from public.outcomes b
        where b.supersedes_id = o.id and b.voided_at is null);

-- ═══════════════════════════════════════════════
-- 8. AUTO-PROFILE ON SIGNUP (anonymous users included)
-- ═══════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ═══════════════════════════════════════════════
-- 9. AUDIT TRIGGERS
-- ═══════════════════════════════════════════════
create or replace function public.audit_assessment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor_user_id, actor_name, service_id, action, entity, entity_id, study_id, detail)
  values (auth.uid(), public.actor_label(), new.service_id,
          case when new.supersedes_id is null then 'create_assessment' else 'supersede_assessment' end,
          'assessment', new.id, new.study_id,
          jsonb_build_object('score', new.score, 'tier', new.tier_id,
                             'type', new.assessment_type, 'supersedes', new.supersedes_id));
  return new;
end; $$;

drop trigger if exists on_assessment_insert on public.assessments;
create trigger on_assessment_insert
  after insert on public.assessments
  for each row execute function public.audit_assessment();

create or replace function public.audit_outcome()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor_user_id, actor_name, service_id, action, entity, entity_id, study_id, detail)
  values (auth.uid(), public.actor_label(), new.service_id,
          case when new.supersedes_id is null then 'create_outcome' else 'supersede_outcome' end,
          'outcome', new.id, new.study_id,
          jsonb_build_object('any_event', new.any_event, 'clavien_dindo', new.clavien_dindo,
                             'supersedes', new.supersedes_id));
  return new;
end; $$;

drop trigger if exists on_outcome_insert on public.outcomes;
create trigger on_outcome_insert
  after insert on public.outcomes
  for each row execute function public.audit_outcome();

-- ═══════════════════════════════════════════════
-- 10. RPCs
-- ═══════════════════════════════════════════════

-- Redeem a service access code. Called right after anonymous sign-in.
-- Returns the service + roster so the client can show "who are you?".
create or replace function public.redeem_service_code(p_code text, p_member_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_service public.services%rowtype;
  v_member  public.service_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Scans active services, one bcrypt comparison each (~100ms). Fine for the
  -- tens of rotations this study will ever have; if it grows into the hundreds,
  -- prefix the code with the service slug and look that up first.
  select * into v_service from public.services
   where active and access_code_hash = crypt(trim(p_code), access_code_hash)
   limit 1;

  if not found then
    -- Log the miss so an admin can spot code-guessing in the audit view.
    insert into public.audit_log (actor_user_id, action, detail)
    values (auth.uid(), 'redeem_failed', jsonb_build_object('len', length(coalesce(p_code, ''))));
    raise exception 'invalid access code' using errcode = '28P01';
  end if;

  -- Optional roster entry. Codes work without a name; the name is what
  -- makes a bad entry traceable to a person, so the UI asks for it.
  if p_member_name is not null and length(trim(p_member_name)) > 0 then
    insert into public.service_members (service_id, display_name)
    values (v_service.id, trim(p_member_name))
    on conflict (service_id, display_name) do update set active = true
    returning * into v_member;
  end if;

  update public.profiles
     set service_id = v_service.id,
         member_id  = coalesce(v_member.id, member_id),
         full_name  = coalesce(nullif(trim(p_member_name), ''), full_name)
   where id = auth.uid();

  insert into public.audit_log (actor_user_id, actor_name, service_id, action, detail)
  values (auth.uid(), coalesce(trim(p_member_name), 'unnamed'), v_service.id, 'redeem_code',
          jsonb_build_object('service', v_service.slug));

  return jsonb_build_object(
    'service', jsonb_build_object('id', v_service.id, 'name', v_service.name, 'slug', v_service.slug,
                                  'hospital_id', v_service.hospital_id, 'hospital_name', v_service.hospital_name),
    'member',  case when v_member.id is null then null
                    else jsonb_build_object('id', v_member.id, 'display_name', v_member.display_name) end,
    'roster',  coalesce((select jsonb_agg(jsonb_build_object('id', id, 'display_name', display_name, 'role', role)
                                          order by display_name)
                           from public.service_members
                          where service_id = v_service.id and active), '[]'::jsonb));
end; $$;

-- Admin-only void. Implemented as an RPC so the tables themselves can stay
-- UPDATE-locked for every role, including admins.
create or replace function public.void_assessment(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required to void a record' using errcode = '22023';
  end if;

  update public.assessments
     set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
   where id = p_id and voided_at is null;

  insert into public.audit_log (actor_user_id, actor_name, action, entity, entity_id, detail)
  values (auth.uid(), public.actor_label(), 'void_assessment', 'assessment', p_id,
          jsonb_build_object('reason', trim(p_reason)));
end; $$;

create or replace function public.void_outcome(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required to void a record' using errcode = '22023';
  end if;

  update public.outcomes
     set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
   where id = p_id and voided_at is null;

  insert into public.audit_log (actor_user_id, actor_name, action, entity, entity_id, detail)
  values (auth.uid(), public.actor_label(), 'void_outcome', 'outcome', p_id,
          jsonb_build_object('reason', trim(p_reason)));
end; $$;

-- Provision a service. Admin-only; the plaintext code is returned ONCE
-- and never stored, so it must be copied at creation time.
create or replace function public.create_service(
  p_name text, p_slug text, p_code text,
  p_hospital_id text default null, p_hospital_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if length(trim(p_code)) < 8 then
    raise exception 'access code must be at least 8 characters' using errcode = '22023';
  end if;

  insert into public.services (name, slug, hospital_id, hospital_name, access_code_hash)
  values (trim(p_name), lower(trim(p_slug)), p_hospital_id, p_hospital_name,
          crypt(trim(p_code), gen_salt('bf')))
  returning id into v_id;

  insert into public.audit_log (actor_user_id, actor_name, service_id, action, detail)
  values (auth.uid(), public.actor_label(), v_id, 'create_service',
          jsonb_build_object('slug', lower(trim(p_slug))));
  return v_id;
end; $$;

-- ═══════════════════════════════════════════════
-- 11. ROW-LEVEL SECURITY
-- Collectors get INSERT + SELECT scoped to their service. There is
-- deliberately NO update or delete policy on assessments/outcomes.
-- ═══════════════════════════════════════════════
alter table public.services        enable row level security;
alter table public.service_members enable row level security;
alter table public.profiles        enable row level security;
alter table public.assessments     enable row level security;
alter table public.outcomes        enable row level security;
alter table public.audit_log       enable row level security;

-- services: you can see your own service; admins see all. Never the hash —
-- the client reads services through the redeem RPC and the view below.
drop policy if exists services_read on public.services;
create policy services_read on public.services for select
  using (public.is_admin() or id = public.current_service_id());

drop policy if exists services_admin_write on public.services;
create policy services_admin_write on public.services for all
  using (public.is_admin()) with check (public.is_admin());

-- roster
drop policy if exists members_read on public.service_members;
create policy members_read on public.service_members for select
  using (public.is_admin() or service_id = public.current_service_id());

drop policy if exists members_insert on public.service_members;
create policy members_insert on public.service_members for insert
  with check (public.is_admin() or service_id = public.current_service_id());

-- profiles: your own row, or any row for an admin
drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles for select
  using (auth.uid() = id or public.is_admin());

drop policy if exists own_profile_write on public.profiles;
create policy own_profile_write on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

-- assessments: read your service (admins read all); insert into your service only
drop policy if exists own_assessments on public.assessments;   -- v1 policy, replaced
drop policy if exists assessments_read on public.assessments;
create policy assessments_read on public.assessments for select
  using (public.is_admin() or service_id = public.current_service_id());

drop policy if exists assessments_insert on public.assessments;
create policy assessments_insert on public.assessments for insert
  with check (
    auth.uid() = user_id
    and service_id is not null
    and service_id = public.current_service_id()
    and voided_at is null          -- a row cannot be born voided
  );
-- NO update / delete policy: append-only, enforced by Postgres.

-- outcomes: same shape
drop policy if exists outcomes_read on public.outcomes;
create policy outcomes_read on public.outcomes for select
  using (public.is_admin() or service_id = public.current_service_id());

drop policy if exists outcomes_insert on public.outcomes;
create policy outcomes_insert on public.outcomes for insert
  with check (
    auth.uid() = user_id
    and service_id is not null
    and service_id = public.current_service_id()
    and voided_at is null
  );
-- NO update / delete policy.

-- audit log: admins read; nobody writes directly (triggers/RPCs are definer)
drop policy if exists audit_admin_read on public.audit_log;
create policy audit_admin_read on public.audit_log for select
  using (public.is_admin());

-- ═══════════════════════════════════════════════
-- 12. GRANTS
-- ═══════════════════════════════════════════════
grant usage on schema public to anon, authenticated;
grant select on public.assessments_current, public.outcomes_current to authenticated;
grant execute on function public.redeem_service_code(text, text) to authenticated;
grant execute on function public.void_assessment(uuid, text)      to authenticated;
grant execute on function public.void_outcome(uuid, text)         to authenticated;
grant execute on function public.create_service(text, text, text, text, text) to authenticated;

-- Keep the bcrypt hash away from the client entirely.
revoke select on public.services from anon, authenticated;
grant select (id, name, slug, hospital_id, hospital_name, active, created_at)
  on public.services to authenticated;

-- ═══════════════════════════════════════════════
-- 13. BOOTSTRAP — run ONCE, by hand, then delete the plaintext
--
--   -- promote yourself to admin (sign in with email first):
--   update public.profiles set role='admin' where email = 'you@example.com';
--
--   -- then create services (returns the id; the code is NOT recoverable):
--   select public.create_service('Dr. Castrellon','castrellon','<strong-code>','LCH','Larkin Community Hospital');
--   select public.create_service('Dr. Salgado','salgado','<strong-code>','LCH','Larkin Community Hospital');
--
-- Treat access codes like passwords: give each service its own, hand them
-- out in person or over a trusted channel, and rotate at rotation change by
-- creating a new service row rather than editing an old one.
-- ═══════════════════════════════════════════════
