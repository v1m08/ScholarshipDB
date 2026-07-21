create or replace function public.prune_scholarship_duplicates(
  p_survivor_id text,
  p_duplicate_ids text[],
  p_source_urls text[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_duplicate_ids text[];
  v_deleted integer;
  v_sources text[];
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select array_agg(distinct duplicate_id)
  into v_duplicate_ids
  from unnest(coalesce(p_duplicate_ids, '{}'::text[])) duplicate_id
  where duplicate_id <> p_survivor_id;

  if coalesce(array_length(v_duplicate_ids, 1), 0) = 0 then
    raise exception 'at least one duplicate id is required';
  end if;
  if not exists (select 1 from public.scholarships where id = p_survivor_id) then
    raise exception 'survivor scholarship does not exist';
  end if;
  if (select count(*) from public.scholarships where id = any(v_duplicate_ids)) <> array_length(v_duplicate_ids, 1) then
    raise exception 'one or more duplicate scholarships do not exist';
  end if;

  perform 1
  from public.scholarships
  where id = p_survivor_id or id = any(v_duplicate_ids)
  for update;

  select coalesce(array_agg(distinct source order by source), '{}'::text[])
  into v_sources
  from (
    select unnest(coalesce(source_urls, '{}'::text[])) as source
    from public.scholarships
    where id = p_survivor_id or id = any(v_duplicate_ids)
    union
    select source_url
    from public.scholarships
    where id = p_survivor_id or id = any(v_duplicate_ids)
    union
    select unnest(coalesce(p_source_urls, '{}'::text[]))
  ) sources
  where source is not null and source <> '';

  update public.scholarship_reports
  set scholarship_id = p_survivor_id
  where scholarship_id = any(v_duplicate_ids);

  update public.scholarship_contributions
  set scholarship_id = p_survivor_id
  where scholarship_id = any(v_duplicate_ids);

  update public.scholarships
  set source_urls = v_sources,
      updated_at = now()
  where id = p_survivor_id;

  delete from public.scholarships
  where id = any(v_duplicate_ids);
  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'survivorId', p_survivor_id,
    'deleted', v_deleted,
    'deletedIds', v_duplicate_ids,
    'sourceUrls', v_sources
  );
end;
$$;

revoke all on function public.prune_scholarship_duplicates(text, text[], text[]) from public, anon, authenticated;
grant execute on function public.prune_scholarship_duplicates(text, text[], text[]) to service_role;
