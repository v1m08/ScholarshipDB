create extension if not exists pgcrypto;

do $$ begin
  create type public.publication_status as enum ('draft', 'published', 'archived');
exception when duplicate_object then null; end $$;

create table if not exists public.scholarships (
  id text primary key,
  title text not null,
  provider text not null,
  source_name text not null,
  source_url text not null check (source_url ~ '^https?://'),
  source_urls text[] not null default '{}',
  source_checked_at date not null default current_date,
  source_missing_fields text[] not null default '{}',
  application_url text not null check (application_url ~ '^https?://'),
  opens date,
  deadline date,
  description text not null default '',
  award jsonb not null default '{"maximum": null, "varies": false}',
  requirements jsonb not null default '{"essay": null, "needBased": null, "meritBased": null, "fee": null}',
  eligibility jsonb not null default '{"countries": [], "states": [], "grades": [], "degreeLevels": [], "fields": [], "minimumGpa": null, "minimumAge": null, "citizenship": [], "tags": [], "other": []}',
  institution_specific boolean not null default false,
  institution_name text,
  institution_types text[] not null default '{}',
  search_text text not null default '',
  search_document tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(provider, '') || ' ' || coalesce(description, '') || ' ' || coalesce(search_text, ''))
  ) stored,
  vetting jsonb not null default '{"status": "unvetted", "vettedAt": null}',
  publication_status public.publication_status not null default 'draft',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.scholarships enable row level security;
drop policy if exists "Public can read published scholarships" on public.scholarships;
create policy "Public can read published scholarships"
  on public.scholarships for select to anon, authenticated
  using (publication_status = 'published');

revoke all on public.scholarships from anon, authenticated;
grant select on public.scholarships to anon, authenticated;

create index if not exists scholarships_publication_deadline_id_idx on public.scholarships(publication_status, deadline nulls last, id);
create index if not exists scholarships_search_document_idx on public.scholarships using gin(search_document);
create index if not exists scholarships_eligibility_idx on public.scholarships using gin(eligibility);

drop function if exists public.search_published_scholarships(text, text, text, text, numeric, text, boolean, date, date, text, integer, boolean);

create or replace function public.search_published_scholarships(
  p_query text default null,
  p_grade text default null,
  p_tag text default null,
  p_state text default null,
  p_minimum_award numeric default null,
  p_institution_scope text default 'all',
  p_include_closed boolean default false,
  p_vetted_only boolean default false,
  p_as_of_date date default current_date,
  p_cursor_deadline date default null,
  p_cursor_id text default null,
  p_limit integer default 100,
  p_include_total boolean default true
) returns table(record jsonb, total_count bigint)
language sql stable security invoker set search_path = public
as $$
  with filtered as (
    select s.* from public.scholarships s
    where s.publication_status = 'published'
      and (p_include_closed or s.deadline is null or s.deadline >= p_as_of_date)
      and (not p_vetted_only or coalesce(s.vetting ->> 'status', 'unvetted') <> 'unvetted')
      and (p_query is null or s.search_document @@ websearch_to_tsquery('english', p_query))
      and (p_grade is null or (s.eligibility -> 'grades') ? p_grade)
      and (p_tag is null or (s.eligibility -> 'tags') ? p_tag)
      and (p_state is null or (s.eligibility -> 'states') ? p_state)
      and (p_minimum_award is null or coalesce((s.award ->> 'maximum')::numeric, 0) >= p_minimum_award)
      and (p_institution_scope = 'all'
        or (p_institution_scope = 'general' and not s.institution_specific)
        or (p_institution_scope = 'institution' and s.institution_specific))
  ), counted as (
    select *, case when p_include_total then count(*) over () end as matched_count from filtered
  )
  select to_jsonb(c) - 'matched_count' - 'search_document', c.matched_count
  from counted c
  where p_cursor_id is null
    or (coalesce(c.deadline, '9999-12-31'::date), c.id) > (coalesce(p_cursor_deadline, '9999-12-31'::date), p_cursor_id)
  order by coalesce(c.deadline, '9999-12-31'::date), c.id
  limit least(greatest(p_limit, 1), 200)
$$;

revoke all on function public.search_published_scholarships(text, text, text, text, numeric, text, boolean, boolean, date, date, text, integer, boolean) from public;
grant execute on function public.search_published_scholarships(text, text, text, text, numeric, text, boolean, boolean, date, date, text, integer, boolean) to anon, authenticated;