-- Realtime that survives bulk changes. Found in the browser run on a real Supabase stack: importing or issuing a round
-- changes hundreds of rows in one transaction; streaming every row to every open screen hit Supabase's realtime limit
-- ("Too many postgres changes messages per second") and the messages were dropped, so other screens missed the change.
-- Now each live table sends ONE "changed" signal per transaction (live_pulse row per table), and the app listens to
-- that single table on one channel and reloads what it shows. Row data never goes over realtime any more.

create table live_pulse (
  topic text primary key,          -- table name
  at timestamptz not null default now(),
  n bigint not null default 0
);
alter table live_pulse enable row level security;
grant select on live_pulse to authenticated;
create policy pulse_read on live_pulse for select to authenticated using (true);   -- table names + times only

-- statement-level, at most once per table per transaction (transaction-local flag)
create or replace function live_pulse_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('dorm.pulse.' || tg_table_name, true), '') <> 'y' then
    perform set_config('dorm.pulse.' || tg_table_name, 'y', true);
    insert into live_pulse (topic, at, n) values (tg_table_name, now(), 1)
    on conflict (topic) do update set at = now(), n = live_pulse.n + 1;
  end if;
  return null;
end $$;
revoke execute on function live_pulse_trigger() from public, anon, authenticated;

do $$
declare t text;
begin
  for t in select unnest(array['profiles', 'tenant_registrations', 'bill_rounds', 'meter_readings', 'bills', 'bill_items',
                               'receipts', 'deposits', 'ledger_entries', 'workers', 'attendance', 'requests', 'request_lines',
                               'attachments', 'request_events', 'salary_plans', 'bank_checks', 'security_events', 'money_kinds',
                               'settings', 'rooms', 'tenants'])
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('create trigger live_pulse after insert or update or delete on %I for each statement execute function live_pulse_trigger()', t);
    insert into live_pulse (topic) values (t) on conflict do nothing;
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table %I', t);
    end if;
  end loop;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table live_pulse;
  end if;
end $$;
