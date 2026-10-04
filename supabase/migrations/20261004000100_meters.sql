-- M4: จดมิเตอร์ในแอป (SPEC §7 "จดมิเตอร์", §9 M4). Same bill rules and flags as §4.6 / import_round.
-- เป้อ/นุ้ย start a draft round from the last one (or import the Excel as before), then record each meter from the
-- phone: photo → (optional AI reading, human confirms) → the room's bill is recomputed at once.

alter table meter_readings add column if not exists via text not null default 'import' check (via in ('import', 'app'));

-- ---------------------------------------------------------------- the §4.6 flags, one place
create or replace function meter_flags(p_has_meter boolean, p_billable boolean, eu numeric, wu numeric,
                                       w_flat numeric, pu numeric) returns text[]
language plpgsql immutable as $$
declare fl text[] := '{}';
begin
  if not p_has_meter then return fl; end if;
  if p_billable and eu is null then fl := array_append(fl, 'missing_elec'); end if;
  if p_billable and w_flat is null and wu is null then fl := array_append(fl, 'missing_water'); end if;
  if eu < 0 then fl := array_append(fl, 'elec_decreased'); end if;
  if wu < 0 then fl := array_append(fl, 'water_decreased'); end if;
  if p_billable and eu = 0 then fl := array_append(fl, 'occupied_zero_use'); end if;
  if eu is not null and pu > 0 and eu > 2 * pu then fl := array_append(fl, 'over_2x_last_month'); end if;
  if not p_billable and (eu > 0 or wu > 0) then fl := array_append(fl, 'vacant_has_use'); end if;
  return fl;
end $$;

-- ---------------------------------------------------------------- last known reading of a room (any earlier round)
create or replace function last_reading(p_room uuid, p_kind text, p_not_round uuid, out curr numeric, out units numeric)
language sql stable security definer set search_path = public as $$
  select x.curr, x.units from (
    select m.curr, m.curr - m.prev as units, rd.created_at
      from meter_readings m join bill_rounds rd on rd.id = m.round_id
     where m.room_id = p_room and m.kind = p_kind and m.curr is not null and rd.id is distinct from p_not_round
    union all
    select case p_kind when 'elec' then b.elec_curr else b.water_curr end,
           case p_kind when 'elec' then b.elec_units else b.water_units end, rd.created_at
      from bills b join bill_rounds rd on rd.id = b.round_id
     where b.room_id = p_room and rd.id is distinct from p_not_round
       and (case p_kind when 'elec' then b.elec_curr else b.water_curr end) is not null
  ) x order by x.created_at desc limit 1
$$;

-- ---------------------------------------------------------------- recompute one draft bill from its prev/curr
create or replace function recompute_bill(p_bill uuid) returns bills
language plpgsql security definer set search_path = public as $$
declare
  b bills%rowtype; ro rooms%rowtype; rd bill_rounds%rowtype;
  billable boolean; eu numeric; wu numeric; e_rate numeric; w_rate numeric; pu numeric;
begin
  select * into b from bills where id = p_bill for update;
  select * into ro from rooms where id = b.room_id;
  select * into rd from bill_rounds where id = b.round_id;
  billable := ro.status in ('occupied', 'staff');
  eu := b.elec_curr - b.elec_prev;
  wu := b.water_curr - b.water_prev;
  e_rate := coalesce(ro.elec_rate_override, (rd.rates->>'elec')::numeric);
  w_rate := (rd.rates->>'water')::numeric;
  select prev_units into pu from meter_readings where round_id = b.round_id and room_id = b.room_id and kind = 'elec';

  update bills set
    elec_units = eu, elec_rate = e_rate,
    elec_amount = case when billable and eu > 0 then round(eu * e_rate, 2) else 0 end,
    water_units = wu, water_rate = w_rate,
    water_amount = case when not billable then 0
                        when ro.water_flat is not null then ro.water_flat
                        when wu > 0 then round(wu * w_rate, 2) else 0 end,
    water_is_flat = billable and ro.water_flat is not null,
    flags = meter_flags(ro.has_meter, billable, eu, wu, ro.water_flat, pu)
  where id = p_bill;

  -- same status rule as the import: vacant rooms that still owe something are receivable
  update bills set status = case when ro.status = 'staff' then 'welfare'
                                 when ro.status = 'occupied' or total <> 0 then 'open'
                                 else 'vacant' end
   where id = p_bill
  returning * into b;
  return b;
end $$;

-- ---------------------------------------------------------------- start_round: new draft round from the last one
create or replace function start_round(p_label text, p_meter_month text, p_issue_date date, p_due_date date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_round uuid;
  d bill_rounds%rowtype;
  ro rooms%rowtype;
  le record; lw record;
  v_bill uuid;
  n int := 0;
begin
  perform require_role('manager', 'finance_field');
  if v_label is null then raise exception using message = 'ใส่ชื่อรอบบิล เช่น พ.ย. 69'; end if;
  if p_due_date is null then raise exception using message = 'ใส่วันครบกำหนดชำระ'; end if;
  perform pg_advisory_xact_lock(hashtext('start_round'));
  select * into d from bill_rounds where status = 'draft' limit 1;
  if found then
    raise exception using message = format('มีรอบบิล %s ที่ยังไม่วางบิลอยู่ — จดมิเตอร์ต่อในรอบนั้น หรือวางบิลก่อน', d.label);
  end if;
  if exists (select 1 from bill_rounds where label = v_label) then
    raise exception using message = format('มีรอบบิลชื่อ %s แล้ว', v_label);
  end if;
  if not exists (select 1 from rooms) then
    raise exception using message = 'ยังไม่มีห้องในระบบ — นำเข้าแบบฟอร์ม Excel รอบแรกก่อน';
  end if;

  insert into bill_rounds (label, meter_month, issue_date, due_date, rates, bill_info, created_by)
  select v_label, nullif(btrim(coalesce(p_meter_month, '')), ''), p_issue_date, p_due_date,
         (select value from settings where key = 'rates'),
         jsonb_build_object(
           'names', jsonb_object_agg(b.id, coalesce(b.bill_name, b.name)),
           'bank', jsonb_object_agg(b.id, jsonb_build_object('bank', b.bank_name, 'name', b.bank_account_name, 'no', b.bank_account_no)),
           'contact', max(b.contact_phone)),
         me
  from buildings b
  returning id into v_round;

  for ro in select * from rooms order by code loop
    select * into le from last_reading(ro.id, 'elec', v_round);
    select * into lw from last_reading(ro.id, 'water', v_round);
    insert into bills (round_id, room_id, tenant_name, tenant_phone, status, rent,
                       elec_prev, water_prev, service, discount)
    values (v_round, ro.id,
            (select name from tenants where room_id = ro.id and active),
            (select phone from tenants where room_id = ro.id and active),
            'vacant',
            case when ro.status in ('occupied', 'staff') then ro.base_rent else 0 end,
            case when ro.has_meter then le.curr end,
            case when ro.has_meter then lw.curr end,
            case when ro.status in ('occupied', 'staff') then ro.service_fee else 0 end,
            case when ro.status in ('occupied', 'staff') then ro.recurring_discount else 0 end)
    returning id into v_bill;
    if ro.has_meter then
      insert into meter_readings (round_id, room_id, kind, prev, prev_units, via)
      values (v_round, ro.id, 'elec', le.curr, le.units, 'app');
    end if;
    perform recompute_bill(v_bill);
    n := n + 1;
  end loop;
  -- TODO(owner): ยอดค้างของรอบก่อนยังอยู่ในบิลรอบก่อน (ไม่ยกมาเป็น carry_in) — ถ้าอยากให้ยกมาในบิลใหม่ ต้องปิดบิลเก่าด้วย

  return jsonb_build_object('round_id', v_round, 'label', v_label, 'rooms', n);
end $$;

-- ---------------------------------------------------------------- apply one reading (shared by record_meter and the import keeper)
create or replace function apply_meter(p_round uuid, p_room uuid, p_kind text, p_curr numeric, p_prev numeric,
                                       p_photo text, p_ai numeric, p_by uuid, p_by_name text, p_at timestamptz)
returns bills
language plpgsql security definer set search_path = public as $$
declare
  b bills%rowtype; ro rooms%rowtype;
  v_prev numeric; lr record; v_pu numeric;
begin
  select * into ro from rooms where id = p_room;
  select * into b from bills where round_id = p_round and room_id = p_room for update;
  if not found then raise exception using message = format('ห้อง %s ไม่มีบิลในรอบนี้', ro.code); end if;
  if not ro.has_meter then raise exception using message = format('%s ไม่มีมิเตอร์', ro.code); end if;

  v_prev := case p_kind when 'elec' then b.elec_prev else b.water_prev end;
  select * into lr from last_reading(p_room, p_kind, p_round);
  if v_prev is null then v_prev := coalesce(lr.curr, p_prev); end if;
  if v_prev is null then
    raise exception using message = format('ห้อง %s ยังไม่มีเลขครั้งก่อน — ใส่เลขครั้งก่อนด้วย', ro.code);
  end if;
  if p_prev is not null and p_prev <> v_prev then
    raise exception using message = format('ห้อง %s เลขครั้งก่อนคือ %s — แก้เลขครั้งก่อนในหน้านี้ไม่ได้ ถ้ามิเตอร์ถูกเปลี่ยน แจ้งกวาง',
                                           ro.code, trim(to_char(v_prev, 'FM999,999,990.##')));
  end if;
  select prev_units into v_pu from meter_readings where round_id = p_round and room_id = p_room and kind = p_kind;
  if p_kind = 'elec' then v_pu := coalesce(v_pu, lr.units); else v_pu := null; end if;

  insert into meter_readings as m (round_id, room_id, kind, prev, curr, prev_units, ai_value, photo_path,
                                   read_by, read_by_name, read_at, via)
  values (p_round, p_room, p_kind, v_prev, p_curr, v_pu, p_ai, p_photo, p_by, p_by_name, p_at, 'app')
  on conflict (round_id, room_id, kind) do update set
    prev = excluded.prev, curr = excluded.curr, prev_units = coalesce(m.prev_units, excluded.prev_units),
    ai_value = excluded.ai_value, photo_path = coalesce(excluded.photo_path, m.photo_path),
    read_by = excluded.read_by, read_by_name = excluded.read_by_name, read_at = excluded.read_at, via = 'app';

  if p_kind = 'elec' then
    update bills set elec_prev = v_prev, elec_curr = p_curr where id = b.id;
  else
    update bills set water_prev = v_prev, water_curr = p_curr where id = b.id;
  end if;
  return recompute_bill(b.id);
end $$;

-- ---------------------------------------------------------------- record_meter: what the phone calls
create or replace function record_meter(p_round uuid, p_room uuid, p_kind text, p_curr numeric,
                                        p_photo_path text default null, p_ai_value numeric default null,
                                        p_prev numeric default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rd bill_rounds%rowtype; b bills%rowtype; ro rooms%rowtype;
  v_name text;
begin
  perform require_role('manager', 'finance_field');
  if p_kind not in ('elec', 'water') then raise exception using message = 'ชนิดมิเตอร์ต้องเป็น ไฟ หรือ น้ำ'; end if;
  if p_curr is null or p_curr < 0 then raise exception using message = 'ใส่เลขมิเตอร์ (ตัวเลข 0 ขึ้นไป)'; end if;
  if p_photo_path is not null and p_photo_path !~ '^meters/' then
    raise exception using message = 'ที่เก็บรูปมิเตอร์ไม่ถูกต้อง';
  end if;
  select * into rd from bill_rounds where id = p_round for share;
  if not found then raise exception using message = 'ไม่พบรอบบิล'; end if;
  if rd.status <> 'draft' then
    raise exception using message = format('รอบบิล %s วางบิลแล้ว แก้เลขมิเตอร์ไม่ได้ — ถ้าต้องแก้ ให้กวางเพิ่มรายการปรับในบิลพร้อมเหตุผล', rd.label);
  end if;
  select display_name into v_name from profiles where id = auth.uid();
  b := apply_meter(p_round, p_room, p_kind, p_curr, p_prev, p_photo_path, p_ai_value, auth.uid(), v_name, now());
  select * into ro from rooms where id = p_room;
  return jsonb_build_object(
    'bill_id', b.id, 'room', ro.code, 'status', b.status, 'flags', to_jsonb(b.flags),
    'elec_prev', b.elec_prev, 'elec_curr', b.elec_curr, 'elec_units', b.elec_units, 'elec_rate', b.elec_rate,
    'elec_amount', b.elec_amount, 'water_prev', b.water_prev, 'water_curr', b.water_curr, 'water_units', b.water_units,
    'water_amount', b.water_amount, 'total', b.total);
end $$;

-- ---------------------------------------------------------------- meter screen data for one round
create or replace function meter_sheet(p_round uuid)
returns table (room_id uuid, code text, building_id text, room_status room_status_t, tenant_name text,
               water_flat numeric, elec_prev numeric, elec_curr numeric, elec_units numeric, prev_units numeric,
               water_prev numeric, water_curr numeric, ai_value numeric, photo_path text, read_by_name text,
               read_at timestamptz, flags text[], total numeric, elec_rate numeric, water_rate numeric)
language sql stable security definer set search_path = public as $$
  select ro.id, ro.code, ro.building_id, ro.status, b.tenant_name, ro.water_flat,
         coalesce(b.elec_prev, (select l.curr from last_reading(ro.id, 'elec', p_round) l)),
         b.elec_curr, b.elec_units,
         coalesce(me.prev_units, (select l.units from last_reading(ro.id, 'elec', p_round) l)),
         coalesce(b.water_prev, (select l.curr from last_reading(ro.id, 'water', p_round) l)),
         b.water_curr, me.ai_value, me.photo_path, me.read_by_name, me.read_at, b.flags, b.total,
         coalesce(ro.elec_rate_override, (rd.rates->>'elec')::numeric), (rd.rates->>'water')::numeric
    from bills b join rooms ro on ro.id = b.room_id join bill_rounds rd on rd.id = b.round_id
    left join meter_readings me on me.round_id = b.round_id and me.room_id = b.room_id and me.kind = 'elec'
   where b.round_id = p_round and ro.has_meter and is_staff()
   order by ro.building_id, ro.code
$$;

-- ---------------------------------------------------------------- re-importing the Excel keeps readings taken in the app
alter function import_round(jsonb) rename to import_round_core;
revoke execute on function import_round_core(jsonb) from authenticated;

create or replace function import_round(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_label text := jtext(coalesce(payload->'settings', '{}'::jsonb), 'label');
  kept jsonb;
  k jsonb;
  res jsonb;
  v_round uuid;
  n int := 0;
begin
  perform require_role('manager', 'finance_field');
  select coalesce(jsonb_agg(jsonb_build_object(
           'room_id', m.room_id, 'kind', m.kind, 'curr', m.curr, 'prev', m.prev, 'photo', m.photo_path,
           'ai', m.ai_value, 'by', m.read_by, 'by_name', m.read_by_name, 'at', m.read_at)), '[]')
    into kept
    from meter_readings m join bill_rounds rd on rd.id = m.round_id
   where rd.label = v_label and rd.status = 'draft' and m.via = 'app' and m.curr is not null;

  res := import_round_core(payload);
  v_round := (res->>'round_id')::uuid;

  -- a reading from the phone wins over an empty cell in the sheet; a number typed in the sheet wins over the phone
  for k in select * from jsonb_array_elements(kept) loop
    if exists (select 1 from bills b where b.round_id = v_round and b.room_id = (k->>'room_id')::uuid)
       and not exists (select 1 from meter_readings m where m.round_id = v_round and m.room_id = (k->>'room_id')::uuid
                          and m.kind = k->>'kind' and m.curr is not null) then
      begin
        perform apply_meter(v_round, (k->>'room_id')::uuid, k->>'kind', (k->>'curr')::numeric, null,
                            k->>'photo', (k->>'ai')::numeric, (k->>'by')::uuid, k->>'by_name', (k->>'at')::timestamptz);
        n := n + 1;
      exception when others then
        null; -- the sheet changed the room (e.g. no meter any more): the sheet wins
      end;
    end if;
  end loop;

  if n > 0 then
    select jsonb_agg(ro.code order by ro.code) into k
      from bills b join rooms ro on ro.id = b.room_id
     where b.round_id = v_round and ro.status = 'occupied' and 'missing_elec' = any(b.flags);
    res := res || jsonb_build_object('kept_app_readings', n, 'blocking', coalesce(k, '[]'::jsonb),
                                     'flagged', (select count(*) from bills where round_id = v_round and cardinality(flags) > 0));
  end if;
  return res;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function meter_flags(boolean, boolean, numeric, numeric, numeric, numeric),
  last_reading(uuid, text, uuid), recompute_bill(uuid),
  apply_meter(uuid, uuid, text, numeric, numeric, text, numeric, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function import_round(jsonb), start_round(text, text, date, date),
  record_meter(uuid, uuid, text, numeric, text, numeric, numeric), meter_sheet(uuid) to authenticated;
