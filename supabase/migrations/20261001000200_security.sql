-- Helpers, audit log, append-only ledger, Row Level Security (SPEC §1.4, §1.5, §1.9)

-- ---------------------------------------------------------------- helpers
create or replace function today_th() returns date
language sql stable as $$ select (now() at time zone 'Asia/Bangkok')::date $$;

-- role of the caller (null = anonymous or inactive)
create or replace function my_role() returns role_t
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() in ('ceo','manager','finance_field','finance','auditor'), false)
$$;

-- raise a Thai error unless the caller has one of the roles
create or replace function require_role(variadic allowed role_t[]) returns role_t
language plpgsql stable security definer set search_path = public as $$
declare r role_t := my_role();
begin
  if r is null then
    raise exception using message = 'กรุณาเข้าสู่ระบบก่อน', errcode = '42501';
  end if;
  if not (r = any(allowed)) and r <> 'ceo' then
    raise exception using message = 'คุณไม่มีสิทธิ์ทำรายการนี้', errcode = '42501';
  end if;
  return r;
end $$;

create or replace function wallet_for_building(b text) returns text
language sql immutable as $$ select case b when 'N' then 'N' when 'P' then 'P' end $$;

-- ---------------------------------------------------------------- audit log
create or replace function audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  n jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  rid text := coalesce(n->>'id', o->>'id', n->>'key', o->>'key', n->>'profile_id', o->>'profile_id');
begin
  -- never copy secrets into the audit trail
  if tg_table_name = 'activation_codes' then
    o := o - 'code_hash'; n := n - 'code_hash';
  end if;
  insert into audit_log (table_name, row_id, action, old, new, actor)
  values (tg_table_name, rid, lower(tg_op), o, n, auth.uid());
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','activation_codes','buildings','wallets','settings','projects','rooms','tenants',
    'tenant_registrations','bill_rounds','meter_readings','bills','bill_items','receipts','deposits',
    'ledger_entries','workers','attendance','requests','request_lines','attachments','request_events',
    'salary_plans','bank_checks']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$I
                    for each row execute function audit_trigger()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- append-only tables
create or replace function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception using message = format('ตาราง %s แก้ไขหรือลบไม่ได้ — ให้บันทึกรายการกลับรายการแทน', tg_table_name),
                        errcode = '42501';
end $$;

create trigger ledger_append_only before update or delete on ledger_entries
  for each row execute function forbid_change();
create trigger ledger_no_truncate before truncate on ledger_entries
  for each statement execute function forbid_change();
create trigger audit_append_only before update or delete on audit_log
  for each row execute function forbid_change();
create trigger receipts_append_only before update or delete on receipts
  for each row execute function forbid_change();
create trigger history_append_only before update or delete on ledger_history
  for each row execute function forbid_change();

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- The browser only ever SELECTs; every write goes through a security-definer RPC.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
grant execute on function my_role(), is_staff(), today_th() to authenticated;

-- staff (non-worker) read access to operational tables
do $$
declare t text;
begin
  foreach t in array array[
    'buildings','wallets','settings','projects','rooms','tenants','tenant_registrations','bill_rounds',
    'meter_readings','bills','bill_items','receipts','deposits']
  loop
    execute format('grant select on %I to authenticated', t);
    execute format('create policy staff_read on %I for select to authenticated using (is_staff())', t);
  end loop;
end $$;

-- workers may see buildings & projects (to pick a project at check-in)
create policy worker_read on buildings for select to authenticated using (my_role() = 'worker');
create policy worker_read on projects for select to authenticated using (my_role() = 'worker');

-- money tables: not the manager, not workers
grant select on ledger_entries, bank_checks, ledger_history to authenticated;
create policy money_read on ledger_entries for select to authenticated
  using (my_role() in ('ceo','finance','finance_field','auditor'));
create policy money_read on bank_checks for select to authenticated
  using (my_role() in ('ceo','finance','finance_field','auditor'));
create policy money_read on ledger_history for select to authenticated
  using (my_role() in ('ceo','finance','auditor'));

-- profiles: everyone sees self; staff see everyone
grant select on profiles to authenticated;
create policy self_read on profiles for select to authenticated using (id = auth.uid() or is_staff());

-- salary plans: owner of the plan, finance, ceo, auditor
grant select on salary_plans to authenticated;
create policy plan_read on salary_plans for select to authenticated
  using (profile_id = auth.uid() or my_role() in ('ceo','finance','finance_field','auditor'));

-- workers: the national ID column is never readable directly; use v_workers (masked)
grant select (id, full_name, kind, daily_rate, phone, id_card_path, is_team_lead, active, created_at)
  on workers to authenticated;
create policy staff_read on workers for select to authenticated using (is_staff());
create policy self_read on workers for select to authenticated
  using (id = (select worker_id from profiles where id = auth.uid()));

-- crew & request tables: staff read; a worker reads only own rows
grant select on attendance, requests, request_lines, request_events, attachments to authenticated;
create policy staff_read on attendance for select to authenticated using (is_staff());
create policy self_read on attendance for select to authenticated
  using (worker_id = (select worker_id from profiles where id = auth.uid()));
create policy staff_read on requests for select to authenticated using (is_staff());
create policy self_read on requests for select to authenticated using (requester_id = auth.uid());
create policy staff_read on request_lines for select to authenticated using (is_staff());
create policy self_read on request_lines for select to authenticated
  using (worker_id = (select worker_id from profiles where id = auth.uid()));
create policy staff_read on request_events for select to authenticated using (is_staff());
create policy staff_read on attachments for select to authenticated using (is_staff());
create policy self_read on attachments for select to authenticated using (created_by = auth.uid());

-- audit log: ceo, finance, auditor
grant select on audit_log to authenticated;
create policy audit_read on audit_log for select to authenticated
  using (my_role() in ('ceo','finance','auditor'));

-- activation_codes / login_attempts: no client access at all (edge functions use the service role)

-- ---------------------------------------------------------------- masked worker view (SPEC §1.8)
create or replace function mask_national_id(nid text) returns text
language sql immutable as $$
  select case when nid is null or nid = '' then null
              else 'x-xxxx-xxxxx-' || substr(nid, 11, 2) || '-' || substr(nid, 13, 1) end
$$;
grant execute on function mask_national_id(text) to authenticated;

create view v_workers with (security_barrier) as
  select w.id, w.full_name, w.kind, w.daily_rate, w.phone, w.id_card_path, w.is_team_lead, w.active,
         case when my_role() in ('ceo','finance') then w.national_id else mask_national_id(w.national_id) end as national_id,
         (w.national_id is not null and w.national_id <> '') as has_national_id
  from workers w
  where is_staff() or w.id = (select worker_id from profiles where id = auth.uid());
grant select on v_workers to authenticated;
