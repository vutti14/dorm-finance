-- Unpaid balances move to the next bill (owner decision 1 ต.ค. 69: "ยกมาเปิดไว้ว่าเป็นบิลค้างจ่าย เดี๋ยวให้เขามาเคลียร์แล้วค่อยเอาออก").
-- While the new round is a draft, its bills show the room's current arrears as "ค้างชำระยกมา (รอบ …)". On issue the
-- amount is fixed and the old bills become 'carried' (pointing to the new bill), so the money is owed in one place only:
-- paying the new bill clears it; the old bill can no longer take receipts, penalties or adjustments.

alter table bills drop constraint if exists bills_status_check;
alter table bills add constraint bills_status_check check (status in ('open', 'closed', 'vacant', 'welfare', 'carried'));
alter table bills
  add column if not exists carry_auto numeric(12,2) not null default 0,   -- the part of carry_in the system brought forward
  add column if not exists carry_note text,                               -- which rounds it came from, e.g. "ต.ค. 69"
  add column if not exists carried_to uuid references bills;              -- on a 'carried' bill: where the balance went

-- what a room still owes on issued bills of other rounds
create or replace function room_arrears(p_room uuid, p_round uuid, out amount numeric, out labels text)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(b.total - b.paid), 0), string_agg(rd.label, ', ' order by rd.due_date, rd.created_at)
    from bills b join bill_rounds rd on rd.id = b.round_id
   where b.room_id = p_room and b.round_id <> p_round and rd.status = 'issued'
     and b.status = 'open' and b.total - b.paid > 0
$$;

-- refresh the brought-forward part on every bill of a draft round (staff rooms keep their own bills: not cash)
create or replace function refresh_carry(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record; a record;
begin
  for b in select bl.*, ro.status as room_status from bills bl join rooms ro on ro.id = bl.room_id
            where bl.round_id = p_round for update of bl loop
    if b.status = 'welfare' then continue; end if;
    select * into a from room_arrears(b.room_id, p_round);
    if a.amount = b.carry_auto and a.labels is not distinct from b.carry_note then continue; end if;
    update bills set carry_in = carry_in - carry_auto + a.amount, carry_auto = a.amount, carry_note = a.labels
     where id = b.id;
    update bills set status = case when b.room_status = 'occupied' or total <> 0 then 'open' else 'vacant' end
     where id = b.id;
  end loop;
end $$;

-- a carried bill is frozen: its balance lives on the newer bill
create or replace function guard_carried_bill() returns trigger
language plpgsql as $$
declare lbl text;
begin
  if old.status = 'carried' and (new.paid, new.items_total, new.penalty, new.carry_in, new.status)
                                is distinct from (old.paid, old.items_total, old.penalty, old.carry_in, old.status) then
    select rd.label into lbl from bills b join bill_rounds rd on rd.id = b.round_id where b.id = old.carried_to;
    raise exception using message = format('ยอดค้างของบิลนี้ยกไปบิลรอบ %s แล้ว — รับเงิน/ปรับยอดที่บิลรอบนั้น', coalesce(lbl, 'ถัดไป'));
  end if;
  return new;
end $$;
create trigger bills_guard_carried before update on bills for each row execute function guard_carried_bill();

-- ---------------------------------------------------------------- start_round: draft shows the arrears
alter function start_round(text, text, date, date) rename to start_round_core;
revoke execute on function start_round_core(text, text, date, date) from authenticated;

create or replace function start_round(p_label text, p_meter_month text, p_issue_date date, p_due_date date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  res := start_round_core(p_label, p_meter_month, p_issue_date, p_due_date);
  perform refresh_carry((res->>'round_id')::uuid);
  return res || jsonb_build_object('carried_rooms',
    (select count(*) from bills where round_id = (res->>'round_id')::uuid and carry_auto > 0));
end $$;

-- ---------------------------------------------------------------- import_round: same, after the sheet is loaded
alter function import_round(jsonb) rename to import_round_keep;
revoke execute on function import_round_keep(jsonb) from authenticated;

create or replace function import_round(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare res jsonb; v_round uuid; both_ text;
begin
  res := import_round_keep(payload);
  v_round := (res->>'round_id')::uuid;
  perform refresh_carry(v_round);
  select string_agg(ro.code, ', ' order by ro.code) into both_
    from bills b join rooms ro on ro.id = b.room_id
   where b.round_id = v_round and b.carry_auto > 0 and b.carry_in - b.carry_auto <> 0;
  if both_ is not null then
    res := jsonb_set(res, '{warnings}', coalesce(res->'warnings', '[]'::jsonb) || jsonb_build_object(
      'sheet', 'ยอดค้างยกมา', 'room', both_,
      'message', 'ห้องนี้มียอดค้างในระบบอยู่แล้ว (ระบบยกมาให้เอง) — ลบยอดในแท็บยอดค้างยกมาแล้วนำเข้าใหม่ ไม่เช่นนั้นจะวางบิลไม่ได้'));
  end if;
  return res;
end $$;

-- ---------------------------------------------------------------- issue_round: fix the amount, mark old bills carried
alter function issue_round(uuid) rename to issue_round_core;
revoke execute on function issue_round_core(uuid) from authenticated;

create or replace function issue_round(p_round uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rd bill_rounds%rowtype; both_ text; res jsonb; n int;
begin
  perform require_role('manager', 'finance_field');
  select * into rd from bill_rounds where id = p_round for update;
  if not found then raise exception using message = 'ไม่พบรอบบิล'; end if;
  if rd.status = 'draft' then
    perform refresh_carry(p_round);   -- payments made while the round was a draft
    select string_agg(ro.code, ', ' order by ro.code) into both_
      from bills b join rooms ro on ro.id = b.room_id
     where b.round_id = p_round and b.carry_auto > 0 and b.carry_in - b.carry_auto <> 0;
    if both_ is not null then
      raise exception using message = format(
        'ห้อง %s มียอดค้างยกมาจาก Excel และยอดค้างในระบบซ้ำกัน — ลบยอดในแท็บยอดค้างยกมาแล้วนำเข้าใหม่ (ระบบยกยอดค้างให้เอง)', both_);
    end if;
  end if;

  res := issue_round_core(p_round);

  update bills ob set status = 'carried', carried_to = nb.id
    from bills nb join bill_rounds nrd on nrd.id = nb.round_id
   where nb.round_id = p_round and nb.carry_auto > 0 and ob.room_id = nb.room_id and ob.round_id <> p_round
     and ob.status = 'open' and ob.total - ob.paid > 0
     and ob.round_id in (select id from bill_rounds where status = 'issued' and id <> p_round);
  get diagnostics n = row_count;
  return res || jsonb_build_object('carried_bills', n);
end $$;

-- ---------------------------------------------------------------- summary: what moved on to a later bill
create or replace view v_round_summary with (security_invoker) as
  select b.round_id, ro.building_id,
         count(*) filter (where b.status <> 'vacant') as billed_rooms,
         count(*) filter (where b.status = 'vacant') as vacant_rooms,
         count(*) filter (where b.status = 'open') as open_rooms,
         count(*) filter (where b.status = 'closed') as closed_rooms,
         count(*) filter (where cardinality(b.flags) > 0) as flagged_rooms,
         coalesce(sum(b.total) filter (where b.status <> 'vacant'), 0) as billed_total,
         coalesce(sum(b.total) filter (where b.status in ('open', 'closed')), 0) as receivable_total,
         coalesce(sum(b.paid), 0) as received,
         coalesce(sum(b.total - b.paid) filter (where b.status = 'open'), 0) as outstanding,
         coalesce(sum(b.rent), 0) as rent, coalesce(sum(b.elec_amount), 0) as elec,
         coalesce(sum(b.water_amount), 0) as water, coalesce(sum(b.service), 0) as service,
         coalesce(sum(b.discount), 0) as discount, coalesce(sum(b.items_total), 0) as items,
         coalesce(sum(b.penalty), 0) as penalty, coalesce(sum(b.carry_in), 0) as carry_in,
         count(*) filter (where b.status = 'carried') as carried_rooms,
         coalesce(sum(b.total - b.paid) filter (where b.status = 'carried'), 0) as carried_out
    from bills b join rooms ro on ro.id = b.room_id
   group by b.round_id, ro.building_id;

revoke execute on function room_arrears(uuid, uuid), refresh_carry(uuid) from public, anon, authenticated;
grant execute on function start_round(text, text, date, date), import_round(jsonb), issue_round(uuid) to authenticated;
