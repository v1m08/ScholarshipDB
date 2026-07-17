create table if not exists public.scholarship_contributions (
  id uuid primary key default gen_random_uuid(),
  scholarship_id text references public.scholarships(id),
  scholarship_title text not null check (char_length(trim(scholarship_title)) between 1 and 200),
  provider text not null check (char_length(trim(provider)) between 1 and 200),
  contributor_name text check (contributor_name is null or char_length(trim(contributor_name)) between 1 and 100),
  relationship text not null default 'winner' check (relationship in ('winner', 'finalist', 'other')),
  deadline date,
  award_amount numeric(12, 2) check (award_amount between 0 and 100000000),
  minimum_gpa numeric(3, 2) check (minimum_gpa between 0 and 5),
  maximum_income numeric(12, 2) check (maximum_income between 0 and 100000000),
  location text not null check (char_length(trim(location)) between 1 and 200),
  grade text not null check (grade in (
    'Kindergarten', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8',
    'High School Freshman', 'High School Sophomore', 'High School Junior', 'High School Senior',
    'High School Graduate', 'High School Student', 'College Freshman', 'College Sophomore', 'College Junior',
    'College Senior', 'Undergraduate', 'Community College Student', 'Vocational or Trade Student',
    'Graduate Student', 'Doctoral Student', 'Law Student', 'Medical Student', 'Not Currently Enrolled'
  )),
  degree_level text check (degree_level is null or degree_level in (
    'Professional Certification', '1-year Certificate', 'Associate Degree', 'Bachelor''s Degree', 'Graduate Degree', 'Doctoral Degree'
  )),
  field_of_study text check (field_of_study is null or char_length(trim(field_of_study)) between 1 and 200),
  citizenship text not null check (citizenship in (
    'No citizenship requirement', 'U.S. citizen', 'U.S. permanent resident',
    'U.S. resident (citizenship not required)', 'DACA recipient', 'International student eligible', 'Other / not sure'
  )),
  essay_required boolean,
  recommendations_required boolean,
  need_based boolean,
  merit_based boolean,
  fee_required boolean,
  application_requirements text check (application_requirements is null or char_length(trim(application_requirements)) between 1 and 2000),
  application_url text check (
    application_url is null
    or (char_length(application_url) <= 2048 and application_url ~* '^https?://[^[:space:]]+$')
  ),
  source_name text not null check (char_length(trim(source_name)) between 1 and 200),
  source_url text check (
    source_url is null
    or (char_length(source_url) <= 2048 and source_url ~* '^https?://[^[:space:]]+$')
  ),
  notes text check (notes is null or char_length(trim(notes)) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'applied', 'rejected')),
  review_notes text check (review_notes is null or char_length(trim(review_notes)) between 1 and 2000),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check (application_url is not null or source_url is not null)
);

alter table public.scholarship_contributions enable row level security;

revoke all on public.scholarship_contributions from anon, authenticated;
grant insert (
  scholarship_id,
  scholarship_title,
  provider,
  contributor_name,
  relationship,
  deadline,
  award_amount,
  minimum_gpa,
  maximum_income,
  location,
  grade,
  degree_level,
  field_of_study,
  citizenship,
  essay_required,
  recommendations_required,
  need_based,
  merit_based,
  fee_required,
  application_requirements,
  application_url,
  source_name,
  source_url,
  notes
) on public.scholarship_contributions to anon, authenticated;
grant all privileges on table public.scholarship_contributions to service_role;

drop policy if exists "Public can submit scholarship contributions" on public.scholarship_contributions;
create policy "Public can submit scholarship contributions"
  on public.scholarship_contributions for insert to anon, authenticated
  with check (
    status = 'pending'
    and relationship in ('winner', 'finalist', 'other')
    and char_length(trim(provider)) between 1 and 200
    and char_length(trim(location)) between 1 and 200
    and char_length(trim(source_name)) between 1 and 200
    and (application_url is not null or source_url is not null)
    and (
      scholarship_id is null
      or exists (
        select 1
        from public.scholarships
        where scholarships.id = scholarship_contributions.scholarship_id
          and scholarships.publication_status = 'published'
      )
    )
  );

create index if not exists scholarship_contributions_scholarship_id_idx
  on public.scholarship_contributions(scholarship_id);

create index if not exists scholarship_contributions_status_created_at_idx
  on public.scholarship_contributions(status, created_at desc);
