-- Phase A only: private staging tables for a BigFuture-first restoration.
-- This migration does not read from or write to public.scholarships.

create extension if not exists pgcrypto;
create schema if not exists internal;

revoke all on schema internal from public, anon, authenticated;

create table if not exists internal.scholarship_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  priority integer not null check (priority between 0 and 1000),
  created_at timestamptz not null default now()
);

create table if not exists internal.scholarship_source_records (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references internal.scholarship_sources(id),
  external_id text not null,
  source_url text,
  source_checked_at date,
  raw_record jsonb not null,
  raw_hash text not null,
  ingested_at timestamptz not null default now(),
  unique (source_id, external_id, raw_hash)
);

create table if not exists internal.scholarship_normalized_records (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null unique references internal.scholarship_source_records(id),
  normalized_record jsonb not null,
  normalization_version integer not null default 1,
  normalized_at timestamptz not null default now()
);

create table if not exists internal.scholarship_restoration_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft'
    check (status in ('draft', 'audited', 'approved', 'applied', 'rolled_back', 'failed')),
  source_manifest jsonb not null default '{}'::jsonb,
  audit_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  applied_at timestamptz,
  rolled_back_at timestamptz
);

create table if not exists internal.scholarship_entities (
  entity_key text primary key,
  restoration_run_id uuid not null references internal.scholarship_restoration_runs(id),
  source_priority_origin uuid references internal.scholarship_sources(id),
  current_record jsonb,
  proposed_record jsonb not null,
  resolution_status text not null default 'ready'
    check (resolution_status in ('ready', 'review_required', 'approved', 'applied')),
  updated_at timestamptz not null default now()
);

create table if not exists internal.scholarship_field_values (
  id uuid primary key default gen_random_uuid(),
  restoration_run_id uuid not null references internal.scholarship_restoration_runs(id),
  entity_key text not null references internal.scholarship_entities(entity_key),
  source_record_id uuid references internal.scholarship_source_records(id),
  field_name text not null,
  source_name text not null,
  source_priority integer not null check (source_priority between 0 and 1000),
  raw_value jsonb,
  normalized_value jsonb,
  current_value jsonb,
  chosen_value jsonb,
  chosen_reason text not null,
  confidence_score numeric(4, 3) not null check (confidence_score between 0 and 1),
  automatic boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (restoration_run_id, entity_key, field_name, source_name)
);

create table if not exists internal.scholarship_restoration_snapshots (
  restoration_run_id uuid not null references internal.scholarship_restoration_runs(id),
  entity_key text not null,
  record_before jsonb not null,
  captured_at timestamptz not null default now(),
  primary key (restoration_run_id, entity_key)
);

create table if not exists internal.scholarship_review_queue (
  id uuid primary key default gen_random_uuid(),
  restoration_run_id uuid not null references internal.scholarship_restoration_runs(id),
  entity_key text not null,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'resolved')),
  reviewer_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists internal.scholarship_audit_events (
  id bigint generated always as identity primary key,
  restoration_run_id uuid references internal.scholarship_restoration_runs(id),
  entity_key text,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scholarship_source_records_external_idx
  on internal.scholarship_source_records (source_id, external_id);
create index if not exists scholarship_field_values_entity_idx
  on internal.scholarship_field_values (entity_key, field_name);
create index if not exists scholarship_review_queue_pending_idx
  on internal.scholarship_review_queue (restoration_run_id, status)
  where status = 'pending';

insert into internal.scholarship_sources (name, priority)
values ('BigFuture Scholarship Search', 100)
on conflict (name) do update set priority = excluded.priority;

alter table internal.scholarship_sources enable row level security;
alter table internal.scholarship_source_records enable row level security;
alter table internal.scholarship_normalized_records enable row level security;
alter table internal.scholarship_restoration_runs enable row level security;
alter table internal.scholarship_entities enable row level security;
alter table internal.scholarship_field_values enable row level security;
alter table internal.scholarship_restoration_snapshots enable row level security;
alter table internal.scholarship_review_queue enable row level security;
alter table internal.scholarship_audit_events enable row level security;

revoke all on all tables in schema internal from public, anon, authenticated;
revoke all on all sequences in schema internal from public, anon, authenticated;
