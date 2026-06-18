-- ═══════════════════════════════════════════════
-- F2F — Supabase schema + Row-Level Security
-- Run in: Supabase Dashboard → SQL Editor
-- De-identified by design: Study IDs only, NO PHI.
-- ═══════════════════════════════════════════════

-- profiles: one row per auth user
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  email text,
  specialty text,
  created_at timestamptz default now()
);

-- assessments: de-identified saved F2F scores
create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  study_id text,
  hospital text,
  hospital_id text,
  enrollment_date date,
  assessment_type text,
  answers jsonb,
  domain_scores jsonb,
  score int,
  tier_id text,
  tier_label text,
  created_at timestamptz default now()
);

create index if not exists assessments_user_idx on public.assessments (user_id, created_at desc);

-- Row-Level Security: each user sees/writes only their own rows
alter table public.profiles    enable row level security;
alter table public.assessments enable row level security;

drop policy if exists "own_profile" on public.profiles;
create policy "own_profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own_assessments" on public.assessments;
create policy "own_assessments" on public.assessments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Auto-create a profile row whenever a new auth user signs up
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
