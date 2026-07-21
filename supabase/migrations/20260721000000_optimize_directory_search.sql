create index if not exists scholarships_eligibility_tags_idx
  on public.scholarships using gin ((eligibility -> 'tags'));

create index if not exists scholarships_eligibility_grades_idx
  on public.scholarships using gin ((eligibility -> 'grades'));

create index if not exists scholarships_eligibility_states_idx
  on public.scholarships using gin ((eligibility -> 'states'));

create index if not exists scholarships_published_award_idx
  on public.scholarships (((award ->> 'maximum')::numeric))
  where publication_status = 'published';

create or replace function public.search_published_scholarship_summaries(
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
  p_limit integer default 30,
  p_include_total boolean default true
) returns table(record jsonb, total_count bigint)
language sql stable security invoker set search_path = public
as $$
  with matched as materialized (
    select s.id, s.deadline
    from public.scholarships s
    where s.publication_status = 'published'
      and (p_include_closed or s.deadline is null or s.deadline >= p_as_of_date)
      and (not p_vetted_only or coalesce(s.vetting ->> 'status', 'unvetted') <> 'unvetted')
      and (p_query is null or s.search_document @@ websearch_to_tsquery('english', p_query))
      and (p_grade is null or (s.eligibility -> 'grades') ? p_grade)
      and (p_tag is null or (s.eligibility -> 'tags') ? p_tag)
      and (p_state is null or (s.eligibility -> 'states') ? p_state)
      and (p_minimum_award is null or (s.award ->> 'maximum')::numeric >= p_minimum_award)
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
    limit least(greatest(p_limit, 1), 100)
  ), totals as (
    select case when p_include_total then count(*) end as matched_count
    from matched
    where p_include_total
  )
  select jsonb_build_object(
    'id', s.id,
    'title', s.title,
    'provider', s.provider,
    'deadline', s.deadline,
    'description', left(s.description, 240),
    'award', jsonb_build_object('maximum', s.award -> 'maximum', 'varies', coalesce(s.award -> 'varies', 'false'::jsonb)),
    'requirements', jsonb_build_object('essay', s.requirements -> 'essay'),
    'eligibility', jsonb_build_object('minimumGpa', s.eligibility -> 'minimumGpa', 'tags', coalesce((select jsonb_agg(tag) from jsonb_array_elements(s.eligibility -> 'tags') with ordinality as tags(tag, position) where position <= 2), '[]'::jsonb)),
    'institutionSpecific', s.institution_specific,
    'institutionName', s.institution_name,
    'vetting', jsonb_build_object('status', coalesce(s.vetting -> 'status', '"unvetted"'::jsonb), 'vettedAt', s.vetting -> 'vettedAt')
  ), t.matched_count
  from page_ids p
  join public.scholarships s on s.id = p.id
  cross join totals t
  order by coalesce(p.deadline, '9999-12-31'::date), p.id
$$;

revoke all on function public.search_published_scholarship_summaries(text, text, text, text, numeric, text, boolean, boolean, date, date, text, integer, boolean) from public;
grant execute on function public.search_published_scholarship_summaries(text, text, text, text, numeric, text, boolean, boolean, date, date, text, integer, boolean) to anon, authenticated;

analyze public.scholarships;
