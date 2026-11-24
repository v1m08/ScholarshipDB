-- The public scholarship database. Run this once in a new Supabase project
-- (SQL Editor -> paste -> Run). It is safe to run again: nothing is dropped.
--
-- Three tables:
--   schools               one row per college (from the federal IPEDS list)
--   scholarships          one row per scholarship; every fact is its own typed column
--   scholarship_evidence  the sentence each fact was read from (private, for review)
--
-- Visitors (the website) can read schools and PUBLISHED scholarships, nothing else.
-- Only the secret key (used by scripts/load-database.mjs) can write.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------- schools
create table if not exists public.schools (
  unitid   integer primary key,                 -- the federal IPEDS id
  name     text not null check (length(name) between 2 and 200),
  city     text,
  state    text check (state ~ '^[A-Z]{2}$'),
  level    text check (level in ('less-than-two-year', 'two-year', 'four-year')),
  control  text check (control in ('public', 'private-nonprofit', 'private-for-profit')),
  website  text check (website ~ '^https?://'),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- scholarships
-- Joins a list into one string for search. (The built-in function is not allowed inside a
-- stored search column, so this thin wrapper declares it safe.)
create or replace function public.list_words(items text[]) returns text
language sql immutable parallel safe set search_path = '' as $$ select pg_catalog.array_to_string(items, ' ') $$;

do $$ begin
  create type public.publication_status as enum ('draft', 'published', 'archived');
exception when duplicate_object then null; end $$;

create table if not exists public.scholarships (
  -- Made from the scholarship's own address, so loading it again updates the same row.
  id text primary key check (id ~ '^[0-9a-f]{16}$'),
  name text not null check (length(name) between 4 and 200 and name = btrim(name)),
  provider_name text not null check (length(provider_name) between 2 and 200),

  -- Who can apply: anyone ("open"), or only students of one school ("school").
  scope text not null check (scope in ('open', 'school')),
  school_unitid integer references public.schools(unitid),
  constraint school_scope_has_school check (scope = 'open' or school_unitid is not null),

  -- The scholarship's own page, where a student reads the rules and applies.
  url text not null check (url ~ '^https://'),
  source text not null check (source in ('school-portal', 'school-website', 'foundation-website', 'provider-website')),

  -- Money. Null means the page does not say.
  award_min numeric(8, 2) check (award_min > 0 and award_min <= 70000),
  award_max numeric(8, 2) check (award_max > 0 and award_max <= 70000),
  constraint award_range check (award_min is null or award_max is null or award_min <= award_max),
  award_per_year boolean not null default false,
  award_type text check (award_type in ('full-cost', 'last-dollar')),

  -- Dates. A scholarship with a deadline in the past is closed; the website compares to today.
  opens date check (opens between '2020-01-01' and '2035-12-31'),
  deadline date check (deadline between '2020-01-01' and '2035-12-31'),

  -- Who qualifies. Empty list means the page does not restrict it.
  minimum_gpa numeric(3, 2) check (minimum_gpa between 1 and 4),
  grade_levels text[] not null default '{}' check (grade_levels <@ array['grade-9', 'grade-10', 'grade-11', 'grade-12', 'college-freshman', 'college-sophomore', 'college-junior', 'college-senior', 'community-college', 'graduate']),
  fields_of_study text[] not null default '{}',
  citizenship text[] not null default '{}' check (citizenship <@ array['us-citizen', 'permanent-resident', 'daca-undocumented', 'any']),
  tags text[] not null default '{}',
  need text not null default 'no' check (need in ('no', 'considered', 'required')),
  merit text not null default 'no' check (merit in ('no', 'considered', 'required')),
  enrollment text not null default 'either' check (enrollment in ('either', 'full-time', 'part-time')),

  -- What the first application round asks for. Never null: "false" unless the page says so.
  essay boolean not null default false,
  recommendations boolean not null default false,
  transcript boolean not null default false,
  interview boolean not null default false,
  nomination boolean not null default false,
  fee boolean not null default false,
  renewable boolean not null default false,
  has_later_rounds boolean not null default false,

  -- The columns above that the page actually states. Anything not listed is a default.
  stated_fields text[] not null default '{}',

  status public.publication_status not null default 'draft',
  review_batch text,
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  search tsvector generated always as (
    setweight(to_tsvector('english', name), 'A') ||
    setweight(to_tsvector('english', provider_name), 'B') ||
    setweight(to_tsvector('english', public.list_words(fields_of_study) || ' ' || public.list_words(tags)), 'C')
  ) stored
);

-- The website's usual questions: what is open, soonest deadline first, filtered a few ways.
create index if not exists scholarships_listing_idx on public.scholarships (status, deadline, id);
create index if not exists scholarships_scope_idx on public.scholarships (status, scope, deadline);
create index if not exists scholarships_school_idx on public.scholarships (school_unitid) where school_unitid is not null;
create index if not exists scholarships_award_idx on public.scholarships (award_max) where status = 'published';
create index if not exists scholarships_search_idx on public.scholarships using gin (search);
create index if not exists scholarships_name_trgm_idx on public.scholarships using gin (name extensions.gin_trgm_ops);
create index if not exists scholarships_grades_idx on public.scholarships using gin (grade_levels);
create index if not exists scholarships_fields_idx on public.scholarships using gin (fields_of_study);
create index if not exists scholarships_tags_idx on public.scholarships using gin (tags);
create index if not exists scholarships_batch_idx on public.scholarships (review_batch) where review_batch is not null;

-- ---------------------------------------------------------------- evidence
create table if not exists public.scholarship_evidence (
  scholarship_id text not null references public.scholarships(id) on delete cascade,
  field text not null,
  evidence text not null check (length(evidence) <= 600),
  primary key (scholarship_id, field)
);

-- ---------------------------------------------------------------- housekeeping
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists scholarships_touch on public.scholarships;
create trigger scholarships_touch before update on public.scholarships
  for each row execute function public.touch_updated_at();
drop trigger if exists schools_touch on public.schools;
create trigger schools_touch before update on public.schools
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- who can read
alter table public.schools enable row level security;
alter table public.scholarships enable row level security;
alter table public.scholarship_evidence enable row level security;

revoke all on public.schools, public.scholarships, public.scholarship_evidence from anon, authenticated;
grant select on public.schools, public.scholarships to anon, authenticated;
grant all on public.schools, public.scholarships, public.scholarship_evidence to service_role;

drop policy if exists "Anyone can read schools" on public.schools;
create policy "Anyone can read schools" on public.schools
  for select to anon, authenticated using (true);

drop policy if exists "Anyone can read published scholarships" on public.scholarships;
create policy "Anyone can read published scholarships" on public.scholarships
  for select to anon, authenticated using (status = 'published');
-- scholarship_evidence has no policy: only the secret key can read it.

-- ---------------------------------------------------------------- review helpers
-- Publish one reviewed batch:   select public.publish_batch('batch-100');
create or replace function public.publish_batch(batch text) returns integer
language sql security invoker set search_path = '' as $$
  with changed as (
    update public.scholarships set status = 'published'
    where review_batch = batch and status = 'draft' returning 1
  ) select count(*)::integer from changed
$$;
revoke all on function public.publish_batch(text) from public, anon, authenticated;
grant execute on function public.publish_batch(text) to service_role;

-- Tell the API about the new tables straight away.
notify pgrst, 'reload schema';
