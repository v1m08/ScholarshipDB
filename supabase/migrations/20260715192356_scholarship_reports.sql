create table if not exists public.scholarship_reports (
  id uuid primary key default gen_random_uuid(),
  scholarship_id text not null references public.scholarships(id),
  issue text not null check (char_length(trim(issue)) between 10 and 1000),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

alter table public.scholarship_reports enable row level security;

revoke all on public.scholarship_reports from anon, authenticated;
grant insert (scholarship_id, issue) on public.scholarship_reports to anon, authenticated;

drop policy if exists "Public can submit scholarship reports" on public.scholarship_reports;
create policy "Public can submit scholarship reports"
  on public.scholarship_reports for insert to anon, authenticated
  with check (
    char_length(trim(issue)) between 10 and 1000
    and exists (
      select 1
      from public.scholarships
      where scholarships.id = scholarship_reports.scholarship_id
        and scholarships.publication_status = 'published'
    )
  );

create index if not exists scholarship_reports_scholarship_id_idx
  on public.scholarship_reports(scholarship_id);

create index if not exists scholarship_reports_status_created_at_idx
  on public.scholarship_reports(status, created_at desc);
