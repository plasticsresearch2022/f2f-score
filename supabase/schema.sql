-- ═══════════════════════════════════════════════
-- F2F — Supabase schema v2: services, append-only data, audit
-- Run in: Supabase Dashboard → SQL Editor
--
-- De-identified by design: Study IDs only, NO PHI.
--
-- Design notes:
--  * Everyone signs in with GOOGLE. The Gmail account is the identity, so a
--    resident's patients follow them across devices. On first sign-in they
--    pick their surgical service; they can switch when they rotate.
--  * Sign-in is deliberately OPEN — anyone with a Google account can enter
--    data. Every row records who wrote it and everything lands in audit_log,
--    and an admin can block an account, which revokes read and write at once.
--  * Visibility is per SERVICE, not per person: a patient's record spans
--    months and residents rotate, so anyone on the service must be able to
--    continue anyone's patient. "My Patients" in the app is a filter over
--    this, never a security boundary.
--  * Admin is granted only to admin_allowlist, enforced by trigger.
--  * Nothing is ever updated or deleted. Corrections insert a new row
--    that supersedes the old one; voiding is an admin-only RPC. There is
--    deliberately no UPDATE or DELETE policy on the data tables, so
--    Postgres refuses rather than the app trusting itself.
--  * This file is idempotent — safe to re-run.
--
-- PREREQUISITE: the Google OAuth consent screen must be PUBLISHED in GCP.
--   While it is in testing mode only hand-added test users can sign in, which
--   with Google as the only door means nobody can.
--
-- Access codes (redeem_service_code, services.access_code_hash) are retained
-- but unused — they are the fallback for a site without Google access.
-- ═══════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

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
  access_code_hash text,                        -- bcrypt; null since Google sign-in replaced codes
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

alter table public.services alter column access_code_hash drop not null;

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
-- Sign-in is open, so the ability to revoke someone matters more than the
-- ability to stop them arriving. Enforced inside current_service_id() and
-- is_admin(), which every RLS policy already keys off — so one flag closes
-- every door at once.
alter table public.profiles add column if not exists blocked    boolean not null default false;

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
-- 'app' = scored in-app and therefore reconcilable against computeScore.
-- 'import' = carried over from the research spreadsheet, which recorded
-- totals but not the per-question answers, so the integrity check must
-- skip score reconciliation for these or it reports false tampering.
alter table public.assessments add column if not exists source               text not null default 'app';
-- Which revision of the scoring engine produced this score. Point values
-- and scoring rules change upstream, so a score is only meaningful next to
-- the engine that produced it — and only reconcilable against that engine.
-- Rows scored before v1.1 used different rules and must not be silently
-- mixed with current ones in analysis.
alter table public.assessments add column if not exists engine_version       text not null default '1.1';
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

alter table public.outcomes add column if not exists source text not null default 'app';

-- Secondary endpoints and surgical detail the research spreadsheet tracks
-- but the app's outcome form does not yet collect: debridements, flapType,
-- minorComp, minorDetail, readmit30, reop30, los, icu, recur90, fu30, fu90.
-- Kept as jsonb so the export can reproduce Pedro's sheet column-for-column
-- without every one of these becoming a migration.
alter table public.outcomes add column if not exists secondary jsonb not null default '{}'::jsonb;

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
-- 5b. ADMIN ALLOWLIST
--
-- Admin is not something a profile row can claim. It is granted only to
-- the addresses listed here, enforced by a trigger on every insert and
-- update, so the answer is the same however the row is written.
-- ═══════════════════════════════════════════════
create table if not exists public.admin_allowlist (
  email    text primary key,
  added_at timestamptz not null default now()
);

insert into public.admin_allowlist (email) values
  ('yasha.efimenko@gmail.com'),
  ('plasticsresearch2022@gmail.com')
on conflict (email) do nothing;

create or replace function public.enforce_admin_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  -- Resolved from auth.users, NOT from new.email. profiles.email is
  -- client-writable, so trusting it would let anyone type an allowlisted
  -- address into their own row and be promoted.
  select lower(u.email) into v_email from auth.users u where u.id = new.id;

  if v_email is not null and exists (
       select 1 from public.admin_allowlist a where lower(a.email) = v_email) then
    new.role := 'admin';
  elsif new.role = 'admin' then
    new.role := 'collector';       -- silently demote anyone else
  end if;
  return new;
end; $$;

drop trigger if exists profiles_enforce_admin on public.profiles;
create trigger profiles_enforce_admin
  before insert or update on public.profiles
  for each row execute function public.enforce_admin_role();

-- Re-evaluate every existing row against the list.
update public.profiles set role = role;

alter table public.admin_allowlist enable row level security;
drop policy if exists allowlist_admin_read on public.admin_allowlist;
create policy allowlist_admin_read on public.admin_allowlist for select
  using (public.is_admin());

-- ═══════════════════════════════════════════════
-- 6. HELPERS
-- SECURITY DEFINER so they bypass RLS internally — without that,
-- a profiles policy calling is_admin() would recurse forever.
-- ═══════════════════════════════════════════════
-- Both return "nothing" for a blocked user. Because every policy is written in
-- terms of these two, blocking someone revokes read and write everywhere
-- without editing a single policy.
create or replace function public.current_service_id()
returns uuid language sql stable security definer set search_path = public as $$
  select case when blocked then null else service_id end
    from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' and not blocked from public.profiles where id = auth.uid()), false);
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
--
-- security_invoker = true is LOAD-BEARING, not a nicety. A view runs as
-- its owner by default, and the owner here is postgres — so without this
-- these views would bypass RLS completely and hand every collector the
-- whole study. Never drop this setting.
-- ═══════════════════════════════════════════════
drop view if exists public.assessments_current;
create view public.assessments_current with (security_invoker = true) as
  select a.* from public.assessments a
   where a.voided_at is null
     and not exists (
       select 1 from public.assessments b
        where b.supersedes_id = a.id and b.voided_at is null);

drop view if exists public.outcomes_current;
create view public.outcomes_current with (security_invoker = true) as
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
returns jsonb language plpgsql security definer
  -- pgcrypto lives in `extensions` on Supabase, not public; crypt() is
  -- invisible to this function without it on the search_path.
  set search_path = public, extensions as $$
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
    -- Return a failure rather than RAISE: an exception would roll back this
    -- very insert, and then code-guessing would leave no trace at all — which
    -- defeats the point of logging it.
    insert into public.audit_log (actor_user_id, action, detail)
    values (auth.uid(), 'redeem_failed', jsonb_build_object('len', length(coalesce(p_code, ''))));
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
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
    'ok', true,
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

-- Choose or change your own rotation.
--
-- Deliberately an RPC rather than a column grant: profiles.service_id stays
-- unwritable by the client, because that grant is what closed the escalation
-- where anyone could point themselves at another service. Routing it through
-- here means the target is validated and every switch is auditable.
create or replace function public.set_my_service(p_service_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_service public.services%rowtype; v_prev uuid; v_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select service_id, blocked into v_prev, v_blocked from public.profiles where id = auth.uid();
  if v_blocked then
    raise exception 'this account has been blocked' using errcode = '42501';
  end if;

  select * into v_service from public.services where id = p_service_id and active;
  if not found then
    raise exception 'unknown service' using errcode = '22023';
  end if;

  update public.profiles set service_id = v_service.id where id = auth.uid();

  -- Attach the person to the service roster so their name appears in reports
  -- alongside those who joined by code.
  insert into public.service_members (service_id, display_name)
  select v_service.id, coalesce(nullif(trim(p.full_name), ''), p.email, 'Unnamed')
    from public.profiles p where p.id = auth.uid()
  on conflict (service_id, display_name) do update set active = true;

  update public.profiles p
     set member_id = sm.id
    from public.service_members sm
   where p.id = auth.uid() and sm.service_id = v_service.id
     and sm.display_name = coalesce(nullif(trim(p.full_name), ''), p.email, 'Unnamed');

  insert into public.audit_log (actor_user_id, actor_name, service_id, action, detail)
  values (auth.uid(), public.actor_label(), v_service.id,
          case when v_prev is null then 'join_service' else 'switch_service' end,
          jsonb_build_object('from', v_prev, 'to', v_service.id, 'service', v_service.name));

  return jsonb_build_object('ok', true, 'service',
    jsonb_build_object('id', v_service.id, 'name', v_service.name, 'slug', v_service.slug,
                       'hospital_id', v_service.hospital_id, 'hospital_name', v_service.hospital_name));
end; $$;

-- Admin-only block / unblock. One flag revokes read and write everywhere.
create or replace function public.set_user_blocked(p_user_id uuid, p_blocked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot block yourself' using errcode = '22023';
  end if;
  if p_blocked and exists (
       select 1 from public.profiles p join auth.users u on u.id = p.id
        where p.id = p_user_id
          and exists (select 1 from public.admin_allowlist a where lower(a.email) = lower(u.email))) then
    raise exception 'allowlisted administrators cannot be blocked' using errcode = '22023';
  end if;

  update public.profiles set blocked = p_blocked where id = p_user_id;

  insert into public.audit_log (actor_user_id, actor_name, action, entity, entity_id, detail)
  values (auth.uid(), public.actor_label(), case when p_blocked then 'block_user' else 'unblock_user' end,
          'profile', p_user_id, jsonb_build_object('blocked', p_blocked));
end; $$;

-- Everyone who has ever signed in, for the admin Users tab.
create or replace function public.list_users()
returns table (id uuid, email text, full_name text, role text, blocked boolean,
               service_id uuid, service_name text, entries bigint, last_seen timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, u.email, p.full_name, p.role, p.blocked, p.service_id, s.name,
         (select count(*) from public.assessments a where a.user_id = p.id),
         greatest(u.last_sign_in_at, (select max(a.created_at) from public.assessments a where a.user_id = p.id))
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.services s on s.id = p.service_id
   where public.is_admin()
   order by p.blocked, u.email;
$$;

-- Record that someone pulled the dataset. Of everything worth having a trail
-- for in IRB research, "who took a copy of the data" is near the top, and the
-- insert triggers only cover rows being created.
create or replace function public.log_export(p_kind text, p_rows int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.audit_log (actor_user_id, actor_name, service_id, action, entity, detail)
  values (auth.uid(), public.actor_label(), public.current_service_id(), 'export',
          coalesce(nullif(trim(p_kind), ''), 'unknown'),
          jsonb_build_object('rows', greatest(coalesce(p_rows, 0), 0)));
end; $$;

-- Provision a service. Admin-only; the plaintext code is returned ONCE
-- and never stored, so it must be copied at creation time.
create or replace function public.create_service(
  p_name text, p_slug text, p_code text,
  p_hospital_id text default null, p_hospital_name text default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
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

-- services: any signed-in user can list them, because the sign-in flow now ends
-- in "which service are you on?" and the picker has to show the options. Only
-- the name and hospital are granted at the column level — never the hash.
drop policy if exists services_read on public.services;
create policy services_read on public.services for select
  using (auth.uid() is not null);

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

-- A user may edit their own row, but the columns that decide what they can
-- see are locked at the GRANT level below — a policy alone cannot restrict
-- columns, and this policy would otherwise let anyone set their own role or
-- move themselves onto another service.
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
grant execute on function public.log_export(text, int)            to authenticated;
grant execute on function public.set_my_service(uuid)             to authenticated;
grant execute on function public.set_user_blocked(uuid, boolean)  to authenticated;
grant execute on function public.list_users()                     to authenticated;
grant execute on function public.void_outcome(uuid, text)         to authenticated;
grant execute on function public.create_service(text, text, text, text, text) to authenticated;

-- Keep the bcrypt hash away from the client entirely.
revoke select on public.services from anon, authenticated;
grant select (id, name, slug, hospital_id, hospital_name, active, created_at)
  on public.services to authenticated;

-- role, service_id and member_id decide what a session can see, so they are
-- not client-writable at all. Only the SECURITY DEFINER RPCs (which run as
-- the owner and bypass these grants) may set them. RLS cannot express a
-- column restriction, so this has to be a GRANT.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, specialty) on public.profiles to authenticated;

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
