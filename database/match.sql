-- Matching: the scholarships that fit one student, best first, with the reasons.
-- Run after database/schema.sql (SQL Editor -> paste -> Run). Safe to run again.
--
-- Call from the website:
--   select * from public.match_scholarships('{
--     "state": "IA", "state_name": "Iowa", "county": "Polk County", "city": "Des Moines",
--     "school_district": "Des Moines Public Schools", "high_school": "Roosevelt High School",
--     "school_unitid": 153603, "college": "Iowa State University",
--     "levels": ["grade-12"], "gpa": 3.6, "citizenship": "us-citizen", "gender": "women", "enrollment": "full-time",
--     "need": true, "first_generation": true, "military": false, "disability": false,
--     "fields": ["nursing"], "careers": ["nurse"],
--     "heritage": ["Hispanic", "Mexican"], "religion": ["Catholic"],
--     "affiliations": ["4-H", "Hy-Vee", "Farm Bureau"], "family": ["child of a veteran", "parent works at John Deere"],
--     "activities": ["soccer", "band", "volunteering"], "facts": ["left-handed"]
--   }'::jsonb, 100, 0);
-- Every key is optional: a fact the student has not given is never used to rule a scholarship out.
-- "levels" takes every year that describes the student (a returning adult in their second
-- college year is ["adult-returning", "college-sophomore"]); "level" with one value also works.
--
-- A scholarship is ruled out only when a REQUIRED criterion with a fixed vocabulary clearly fails:
-- state, year in school, citizenship, gender, minimum GPA, full- or part-time, and the school
-- for school-only awards. Free-text criteria ("member of the Kuskokwim Corporation") never rule
-- anything out: each is compared, as whole words, with the student's facts of the same kind
-- (a place with places, a college with the college, an affiliation with affiliations) and is
-- either matched or returned in `to_confirm`, which the website can turn into a question.
--
-- include_drafts (fourth argument) is for testing with the secret key before anything is
-- published. Visitors can never see drafts: the table's read rule hides them whatever is passed.
--
-- Returned per scholarship:
--   matched     criteria the student's facts meet (each with its quote)
--   to_confirm  required criteria that could not be decided from the facts given
--   fit         'strong'   every requirement is met and at least one thing matched
--               'likely'   one requirement left to confirm
--               'possible' more left to confirm, known only from a tax filing with open
--                          questions, or not yet read by a model
--   score       for ordering

drop function if exists public.match_questions(jsonb, integer);
drop function if exists public.match_scholarships(jsonb, integer, integer);
drop function if exists public.match_questions(jsonb, integer, boolean);
drop function if exists public.match_scholarships(jsonb, integer, integer, boolean);

drop function if exists public.plain_words(text);

create or replace function public.match_scholarships(profile jsonb, max_rows integer default 100, skip_rows integer default 0, include_drafts boolean default false)
returns table (
  id text, name text, provider_name text, scope text, tier text, url text, apply_url text, contact text, summary text,
  award_min numeric, award_max numeric, award_per_year boolean, awards integer,
  deadline date, deadline_recurring boolean, materials text[], criteria_read boolean,
  matched jsonb, to_confirm jsonb, fit text, score numeric
)
language sql stable security invoker set search_path = ''
as $$
  with given as materialized (
    -- The student's facts, each under the profile key it came from, as plain words: lower
    -- case, letters and digits only, single spaces. Criteria values are compared the same way.
    select key, btrim(regexp_replace(lower(fact), '[^a-z0-9]+', ' ', 'g')) as fact
    from (
      select key, profile->>key as fact from unnest(array['state_name', 'county', 'city', 'school_district', 'high_school', 'college']) as key
      union all
      select key, jsonb_array_elements_text(profile->key) from unnest(array['fields', 'careers', 'heritage', 'religion', 'affiliations', 'family', 'activities', 'facts']) as key
        where jsonb_typeof(profile->key) = 'array'
    ) raw
    where length(btrim(regexp_replace(lower(coalesce(fact, '')), '[^a-z0-9]+', ' ', 'g'))) >= 3
  ),
  -- Which of the student's facts each kind of criterion is compared with.
  compare(kind, keys) as (values
    ('location', array['county', 'city', 'school_district', 'facts']),
    ('high_school', array['high_school', 'school_district', 'facts']),
    ('college', array['college', 'facts']),
    ('field', array['fields', 'facts']),
    ('career', array['careers', 'fields', 'facts']),
    ('heritage', array['heritage', 'facts']),
    ('religion', array['religion', 'affiliations', 'facts']),
    ('affiliation', array['affiliations', 'religion', 'family', 'activities', 'facts']),
    ('family', array['family', 'affiliations', 'facts']),
    ('activity', array['activities', 'affiliations', 'facts']),
    ('age', array['facts']), ('test_score', array['facts']),
    ('other', array['fields', 'careers', 'heritage', 'religion', 'affiliations', 'family', 'activities', 'facts'])
  ),
  -- Per kind: one pattern that finds any of those facts as whole words, and the facts as one string.
  words as materialized (
    select c.kind,
      '\m(' || string_agg(distinct g.fact, '|') || ')\M' as pattern,
      ' ' || string_agg(distinct g.fact, '  ') || ' ' as together
    from compare c join given g on g.key = any (c.keys)
    group by c.kind
  ),
  me as materialized (
    select
      nullif(upper(profile->>'state'), '') as state,
      -- "texas", "state of texas", "texas residents": a place that is the whole state.
      '^(the )?(state of )?' || nullif(btrim(regexp_replace(lower(coalesce(profile->>'state_name', '')), '[^a-z0-9]+', ' ', 'g')), '') || '( state)?( residents?)?$' as whole_state,
      nullif(profile->>'school_unitid', '')::integer as unitid,
      case when jsonb_typeof(profile->'levels') = 'array' and jsonb_array_length(profile->'levels') > 0 then profile->'levels'
           when nullif(profile->>'level', '') is not null then jsonb_build_array(profile->>'level') end as levels,
      nullif(profile->>'gpa', '')::numeric as gpa,
      nullif(profile->>'citizenship', '') as citizenship,
      nullif(profile->>'gender', '') as gender,
      nullif(profile->>'enrollment', '') as enrollment,
      (profile->>'need')::boolean as need,
      (profile->>'first_generation')::boolean as first_generation,
      (profile->>'military')::boolean as military,
      (profile->>'disability')::boolean as disability
  ),
  candidates as (
    select s.id, s.name, s.provider_name, s.scope, s.tier, s.url, s.apply_url, s.contact, s.summary,
      s.award_min, s.award_max, s.award_per_year, s.awards, s.deadline, s.deadline_recurring, s.materials, s.criteria_read, s.criteria
    from public.scholarships s, me
    where (s.status = 'published' or (include_drafts and s.status = 'draft'))
      and (s.deadline is null or s.deadline >= current_date or s.deadline_recurring)
      and (s.scope = 'open' or s.school_unitid = me.unitid)
      -- State: a required place in other states only.
      and (me.state is null or s.required_states = '{}' or me.state = any (s.required_states))
      -- Facts the keyword reader filled, for rows a model has not read.
      and (s.criteria_read or me.levels is null or s.grade_levels = '{}' or exists (select 1 from jsonb_array_elements_text(me.levels) as mine where mine = any (s.grade_levels)))
      and (s.criteria_read or me.gpa is null or s.minimum_gpa is null or me.gpa >= s.minimum_gpa)
      and (s.criteria_read or me.citizenship is null or s.citizenship = '{}' or 'any' = any (s.citizenship) or me.citizenship = any (s.citizenship))
  ),
  judged as (
    select c.id, criterion,
      criterion->>'kind' as kind,
      criterion->>'strength' = 'required' as required,
      case criterion->>'kind'
        when 'level' then case when me.levels is null then null else exists (select 1 from jsonb_array_elements_text(me.levels) as mine where criterion->'values' ? mine) end
        when 'citizenship' then case when me.citizenship is null then null else criterion->'values' ? me.citizenship end
        when 'gender' then case when me.gender is null then null else criterion->'values' ? me.gender end
        when 'enrollment' then case when me.enrollment is null then null else criterion->'values' ? me.enrollment end
        when 'gpa' then case when me.gpa is null then null else me.gpa >= (criterion->'values'->>0)::numeric end
        when 'need' then case when me.need then true else null end
        when 'first_generation' then case when me.first_generation then true else null end
        when 'military' then case when me.military then true else null end
        when 'disability' then case when me.disability then true else null end
        else case when (w.pattern is not null or (criterion->>'kind' = 'location' and me.whole_state is not null)) and exists (
          select 1 from jsonb_array_elements_text(criterion->'values') as value
          cross join lateral (select btrim(regexp_replace(lower(value), '[^a-z0-9]+', ' ', 'g')) as said) v
          -- A fact inside the value ("polk county" in "residents of polk county"), the value
          -- inside a fact ("engineering" in "mechanical engineering"), or the student's whole state.
          where (w.pattern is not null and (v.said ~ w.pattern or (length(v.said) >= 4 and position(' ' || v.said || ' ' in w.together) > 0)))
             or (criterion->>'kind' = 'location' and me.whole_state is not null and v.said ~ me.whole_state)
        ) then true else null end
      end as met
    from candidates c cross join me
    cross join lateral jsonb_array_elements(c.criteria) as criterion
    left join words w on w.kind = criterion->>'kind'
  ),
  summed as (
    select j.id,
      -- A fixed-vocabulary requirement that clearly fails rules the scholarship out.
      bool_or(j.required and j.met is false and j.kind in ('level', 'citizenship', 'gender', 'enrollment', 'gpa')) as ruled_out,
      coalesce(jsonb_agg(j.criterion) filter (where j.met), '[]'::jsonb) as matched,
      coalesce(jsonb_agg(j.criterion) filter (where j.required and j.met is null), '[]'::jsonb) as to_confirm,
      count(*) filter (where j.met and j.required) as met_required,
      count(*) filter (where j.met and not j.required) as met_preferred,
      count(*) filter (where j.required and j.met is null) as open_required,
      -- Matching on something particular to this student counts for more than year or GPA.
      count(*) filter (where j.met and j.kind not in ('level', 'citizenship', 'gender', 'enrollment', 'gpa', 'need')) as met_specific
    from judged j group by j.id
  )
  select c.id, c.name, c.provider_name, c.scope, c.tier, c.url, c.apply_url, c.contact, c.summary,
    c.award_min, c.award_max, c.award_per_year, c.awards, c.deadline, c.deadline_recurring, c.materials, c.criteria_read,
    coalesce(s.matched, '[]'::jsonb), coalesce(s.to_confirm, '[]'::jsonb),
    case
      when not c.criteria_read then 'possible'
      when c.tier = 'filing' and (coalesce(s.open_required, 0) > 0 or coalesce(s.met_required, 0) + coalesce(s.met_preferred, 0) = 0) then 'possible'
      when coalesce(s.open_required, 0) = 0 and (coalesce(s.met_required, 0) + coalesce(s.met_preferred, 0) > 0 or c.scope = 'school') then 'strong'
      when coalesce(s.open_required, 0) <= 1 then 'likely'
      else 'possible'
    end as fit,
    ( coalesce(s.met_specific, 0) * 4 + coalesce(s.met_required, 0) * 2 + coalesce(s.met_preferred, 0)
      - coalesce(s.open_required, 0) * 3
      + case when c.criteria_read then 2 else 0 end
      + case when c.tier = 'page' then 1 else 0 end
      + case when c.scope = 'school' then 1 else 0 end
      + least(coalesce(c.award_max, 0) / 5000.0, 2)
    )::numeric as score
  from candidates c left join summed s on s.id = c.id
  where not coalesce(s.ruled_out, false)
  order by score desc, c.deadline nulls last, c.id
  limit least(greatest(max_rows, 1), 500) offset greatest(skip_rows, 0)
$$;

revoke all on function public.match_scholarships(jsonb, integer, integer, boolean) from public;
grant execute on function public.match_scholarships(jsonb, integer, integer, boolean) to anon, authenticated, service_role;

-- The questions worth asking a student next: the unconfirmed requirements that appear most
-- often among their matches. Same profile as above.
create or replace function public.match_questions(profile jsonb, max_rows integer default 12, include_drafts boolean default false)
returns table (kind text, value text, scholarships bigint)
language sql stable security invoker set search_path = ''
as $$
  select item->>'kind', lower(answer), count(distinct m.id)
  from public.match_scholarships(profile, 500, 0, include_drafts) m
  cross join lateral jsonb_array_elements(m.to_confirm) as item
  cross join lateral jsonb_array_elements_text(item->'values') as answer
  group by 1, 2 order by 3 desc, 2 limit least(greatest(max_rows, 1), 50)
$$;
revoke all on function public.match_questions(jsonb, integer, boolean) from public;
grant execute on function public.match_questions(jsonb, integer, boolean) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
