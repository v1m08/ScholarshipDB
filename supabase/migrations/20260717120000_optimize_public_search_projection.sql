create table if not exists public.published_scholarship_search (
  id text primary key references public.scholarships(id) on delete cascade,
  deadline date,
  search_document tsvector not null,
  vetting_status text not null,
  eligibility jsonb not null,
  award_maximum numeric,
  institution_specific boolean not null
);

alter table public.published_scholarship_search enable row level security;

revoke all on public.published_scholarship_search from anon, authenticated;
grant select on public.published_scholarship_search to anon, authenticated;
grant all on public.published_scholarship_search to service_role;

drop policy if exists "Public can search published scholarships" on public.published_scholarship_search;
create policy "Public can search published scholarships"
  on public.published_scholarship_search for select to anon, authenticated
  using (true);

create index if not exists published_scholarship_search_document_idx
  on public.published_scholarship_search using gin(search_document);
create index if not exists published_scholarship_search_eligibility_idx
  on public.published_scholarship_search using gin(eligibility);
create index if not exists published_scholarship_search_deadline_id_idx
  on public.published_scholarship_search(deadline nulls last, id);

create or replace function public.sync_published_scholarship_search()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.published_scholarship_search where id = old.id;
    return old;
  end if;

  if new.publication_status = 'published' then
    insert into public.published_scholarship_search (
      id,
      deadline,
      search_document,
      vetting_status,
      eligibility,
      award_maximum,
      institution_specific
    ) values (
      new.id,
      new.deadline,
      new.search_document,
      coalesce(new.vetting ->> 'status', 'unvetted'),
      new.eligibility,
      (new.award ->> 'maximum')::numeric,
      new.institution_specific
    )
    on conflict (id) do update set
      deadline = excluded.deadline,
      search_document = excluded.search_document,
      vetting_status = excluded.vetting_status,
      eligibility = excluded.eligibility,
      award_maximum = excluded.award_maximum,
      institution_specific = excluded.institution_specific;
  else
    delete from public.published_scholarship_search where id = new.id;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_published_scholarship_search() from public, anon, authenticated;
grant execute on function public.sync_published_scholarship_search() to service_role;

drop trigger if exists sync_published_scholarship_search on public.scholarships;
create trigger sync_published_scholarship_search
  after insert or update or delete on public.scholarships
  for each row execute function public.sync_published_scholarship_search();

insert into public.published_scholarship_search (
  id,
  deadline,
  search_document,
  vetting_status,
  eligibility,
  award_maximum,
  institution_specific
)
select
  id,
  deadline,
  search_document,
  coalesce(vetting ->> 'status', 'unvetted'),
  eligibility,
  (award ->> 'maximum')::numeric,
  institution_specific
from public.scholarships
where publication_status = 'published'
on conflict (id) do update set
  deadline = excluded.deadline,
  search_document = excluded.search_document,
  vetting_status = excluded.vetting_status,
  eligibility = excluded.eligibility,
  award_maximum = excluded.award_maximum,
  institution_specific = excluded.institution_specific;

delete from public.published_scholarship_search p
where not exists (
  select 1
  from public.scholarships s
  where s.id = p.id
    and s.publication_status = 'published'
);

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
  with matched as materialized (
    select s.id, s.deadline
    from public.published_scholarship_search s
    where (p_include_closed or s.deadline is null or s.deadline >= p_as_of_date)
      and (not p_vetted_only or s.vetting_status <> 'unvetted')
      and (p_query is null or s.search_document @@ websearch_to_tsquery('english', p_query))
      and (p_grade is null or (s.eligibility -> 'grades') ? p_grade)
      and (p_tag is null or (s.eligibility -> 'tags') ? p_tag)
      and (p_state is null or (s.eligibility -> 'states') ? p_state)
      and (p_minimum_award is null or coalesce(s.award_maximum, 0) >= p_minimum_award)
      and (p_institution_scope = 'all'
        or (p_institution_scope = 'general' and not s.institution_specific)
        or (p_institution_scope = 'institution' and s.institution_specific))
  ), page_ids as (
    select m.id, m.deadline
    from matched m
    where p_cursor_id is null
      or (coalesce(m.deadline, '9999-12-31'::date), m.id)
        > (coalesce(p_cursor_deadline, '9999-12-31'::date), p_cursor_id)
    order by coalesce(m.deadline, '9999-12-31'::date), m.id
    limit least(greatest(p_limit, 1), 200)
  ), totals as (
    select case when p_include_total then count(*) end as matched_count
    from matched
    where p_include_total
  )
  select to_jsonb(s) - 'search_document', t.matched_count
  from page_ids p
  join public.scholarships s on s.id = p.id
  cross join totals t
  order by coalesce(p.deadline, '9999-12-31'::date), p.id
$$;

revoke all on function public.search_published_scholarships(text, text, text, text, numeric, text, boolean, boolean, date, date, text, integer, boolean) from public;
grant execute on function public.search_published_scholarships(text, text, text, text, numeric, text, boolean, boolean, date, date, text, integer, boolean) to anon, authenticated, service_role;

analyze public.published_scholarship_search;
