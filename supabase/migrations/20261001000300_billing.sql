-- Billing RPCs (SPEC §4.6, §6, §8.1). Every function: security definer, role-checked, row-locked, Thai errors.

-- numeric from a jsonb field; '' / null / non-numeric -> null
create or replace function jnum(j jsonb, k text) returns numeric
language plpgsql immutable as $$
declare v text := nullif(btrim(coalesce(j->>k, '')), '');
begin
  if v is null then return null; end if;
  return replace(v, ',', '')::numeric;
exception when others then
  return null;
end $$;

create or replace function jtext(j jsonb, k text) returns text
language sql immutable as $$ select nullif(btrim(coalesce(j->>k, '')), '') $$;

create or replace function room_has_meter(code text) returns boolean
language sql immutable as $$ select code !~ '(จอดรถ|โกดัง)' $$;

create or replace function thai_id_ok(nid text) returns boolean
language plpgsql immutable as $$
declare s int := 0; d text := regexp_replace(coalesce(nid, ''), '\D', '', 'g');
begin
  if length(d) <> 13 then return false; end if;
  for i in 1..12 loop
    s := s + substr(d, i, 1)::int * (14 - i);
  end loop;
  return (11 - s % 11) % 10 = substr(d, 13, 1)::int;
end $$;

-- ================================================================ import_round
create or replace function import_round(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  st jsonb := coalesce(payload->'settings', '{}'::jsonb);
  v_label text := jtext(st, 'label');
  v_due date;
  v_issue date;
  v_rates jsonb;
  v_round uuid;
  existing record;
  r jsonb; m jsonb; it jsonb; w jsonb;
  v_room rooms%rowtype;
  v_status room_status_t;
  v_building text;
  billable boolean;
  ep numeric; ec numeric; wp numeric; wc numeric; pu numeric; eu numeric; wu numeric;
  e_rate numeric; w_flat numeric;
  fl text[];
  v_bill uuid;
  items_sum numeric; carry_sum numeric;
  warnings jsonb := '[]'::jsonb;
  blocking text[] := '{}';
  seen text[] := '{}';
  first_import boolean := not exists (select 1 from deposits);
  w_match uuid; w_by_name uuid; w_name text; w_phone text; w_nid text; w_cnt int; w_added int := 0; w_updated int := 0;
  result jsonb;
begin
  perform require_role('manager', 'finance_field');

  if v_label is null then
    raise exception using message = 'แท็บ "ตั้งค่า" ไม่มีชื่อรอบบิล';
  end if;
  v_due := nullif(st->>'due_date', '')::date;
  if v_due is null then
    raise exception using message = 'แท็บ "ตั้งค่า" ไม่มีวันครบกำหนดชำระ';
  end if;
  v_issue := nullif(st->>'issue_date', '')::date;
  if jsonb_array_length(coalesce(payload->'rooms', '[]')) = 0 then
    raise exception using message = 'ไม่พบห้องในแท็บ "ห้องและผู้เช่า"';
  end if;

  v_rates := jsonb_build_object(
    'elec',    coalesce(jnum(st, 'elec_rate'), (select (value->>'elec')::numeric from settings where key = 'rates'), 8),
    'water',   coalesce(jnum(st, 'water_rate'), (select (value->>'water')::numeric from settings where key = 'rates'), 30),
    'pen_day', coalesce(jnum(st, 'pen_day'), (select (value->>'pen_day')::numeric from settings where key = 'rates'), 100),
    'pen_max', coalesce(jnum(st, 'pen_max'), (select (value->>'pen_max')::numeric from settings where key = 'rates'), 3100));

  -- same label: replace while draft, refuse once issued
  select * into existing from bill_rounds where label = v_label for update;
  if found then
    if existing.status <> 'draft' then
      raise exception using message = format(
        'รอบบิล %s วางบิลแล้ว นำเข้าซ้ำไม่ได้ — ถ้าต้องแก้ ให้กวางเพิ่มรายการปรับในบิลห้องนั้นพร้อมเหตุผล', v_label);
    end if;
    delete from bill_rounds where id = existing.id;
  end if;

  -- buildings: names / bank on the bill (only overwrite with non-empty values)
  update buildings b set
    bill_name         = coalesce(jtext(st->'bill_name', b.id), b.bill_name),
    bank_name         = coalesce(jtext(st->'bank'->b.id, 'bank'), b.bank_name),
    bank_account_name = coalesce(jtext(st->'bank'->b.id, 'name'), b.bank_account_name),
    bank_account_no   = coalesce(jtext(st->'bank'->b.id, 'no'), b.bank_account_no),
    contact_phone     = coalesce(jtext(st, 'contact'), b.contact_phone);

  insert into bill_rounds (label, meter_month, issue_date, due_date, rates, bill_info, created_by)
  select v_label, jtext(st, 'meter_month'), v_issue, v_due, v_rates,
         jsonb_build_object(
           'names', jsonb_object_agg(b.id, coalesce(b.bill_name, b.name)),
           'bank', jsonb_object_agg(b.id, jsonb_build_object('bank', b.bank_name, 'name', b.bank_account_name, 'no', b.bank_account_no)),
           'contact', max(b.contact_phone)),
         me
  from buildings b
  returning id into v_round;

  -- ---------------------------------------------------------------- rooms & bills
  for r in select * from jsonb_array_elements(payload->'rooms') loop
    if jtext(r, 'code') is null then continue; end if;
    if jtext(r, 'code') = any(seen) then
      raise exception using message = format('ห้อง %s ซ้ำในแท็บ "ห้องและผู้เช่า"', jtext(r, 'code'));
    end if;
    seen := array_append(seen, jtext(r, 'code'));
    v_building := jtext(r, 'building');
    if v_building not in ('N', 'P') then
      raise exception using message = format('ห้อง %s: อาคารต้องเป็น นารา หรือ ปรายดาว', jtext(r, 'code'));
    end if;
    begin
      v_status := jtext(r, 'status')::room_status_t;
    exception when others then
      raise exception using message = format('ห้อง %s: สถานะไม่ถูกต้อง (มีผู้เช่า/ว่าง/ห้องพนักงาน/ปิดปรับปรุง)', jtext(r, 'code'));
    end;

    insert into rooms (building_id, code, status, base_rent, elec_rate_override, water_flat, service_fee,
                       recurring_discount, has_meter, note)
    values (v_building, jtext(r, 'code'), v_status, coalesce(jnum(r, 'base_rent'), 0), jnum(r, 'elec_rate_override'),
            jnum(r, 'water_flat'), coalesce(jnum(r, 'service_fee'), 0), coalesce(jnum(r, 'recurring_discount'), 0),
            room_has_meter(jtext(r, 'code')), jtext(r, 'note'))
    on conflict (code) do update set
      building_id = excluded.building_id, status = excluded.status, base_rent = excluded.base_rent,
      elec_rate_override = excluded.elec_rate_override, water_flat = excluded.water_flat,
      service_fee = excluded.service_fee, recurring_discount = excluded.recurring_discount,
      has_meter = excluded.has_meter, note = excluded.note
    returning * into v_room;

    -- tenant from the sheet (only when a name is given)
    if jtext(r, 'tenant_name') is not null then
      update tenants set phone = coalesce(jtext(r, 'tenant_phone'), phone),
                         move_in = coalesce(nullif(r->>'move_in', '')::date, move_in)
       where room_id = v_room.id and active and name = jtext(r, 'tenant_name');
      if not found then
        update tenants set active = false, move_out = coalesce(move_out, today_th())
         where room_id = v_room.id and active;
        insert into tenants (room_id, name, phone, move_in, source)
        values (v_room.id, jtext(r, 'tenant_name'), jtext(r, 'tenant_phone'), nullif(r->>'move_in', '')::date, 'import');
      end if;
    end if;

    -- deposits held: opening figure, first import only (money is already inside the opening balances)
    if first_import and coalesce(jnum(r, 'deposit_held'), 0) > 0 then
      insert into deposits (room_id, tenant_name, kind, amount, wallet_id, on_date, recorded_by, note)
      values (v_room.id, jtext(r, 'tenant_name'), 'opening', jnum(r, 'deposit_held'), null,
              coalesce(v_issue, today_th()), me, 'ยอดเงินประกันยกมาจากแบบฟอร์มนำเข้า');
    end if;

    -- meter
    select value into m from jsonb_array_elements(coalesce(payload->'meters', '[]')) where jtext(value, 'code') = v_room.code limit 1;
    ep := jnum(m, 'elec_prev'); ec := jnum(m, 'elec_curr');
    wp := jnum(m, 'water_prev'); wc := jnum(m, 'water_curr');
    pu := jnum(m, 'prev_units');
    eu := case when ep is not null and ec is not null then ec - ep end;
    wu := case when wp is not null and wc is not null then wc - wp end;
    billable := v_room.status in ('occupied', 'staff');
    e_rate := coalesce(v_room.elec_rate_override, (v_rates->>'elec')::numeric);
    w_flat := v_room.water_flat;

    fl := '{}';
    if v_room.has_meter then
      if billable and eu is null then fl := array_append(fl, 'missing_elec'); end if;
      if billable and w_flat is null and wu is null then fl := array_append(fl, 'missing_water'); end if;
      if eu < 0 then fl := array_append(fl, 'elec_decreased'); end if;
      if wu < 0 then fl := array_append(fl, 'water_decreased'); end if;
      if billable and eu = 0 then fl := array_append(fl, 'occupied_zero_use'); end if;
      if eu is not null and pu > 0 and eu > 2 * pu then fl := array_append(fl, 'over_2x_last_month'); end if;
      if not billable and (eu > 0 or wu > 0) then fl := array_append(fl, 'vacant_has_use'); end if;
    end if;
    if v_room.status = 'occupied' and 'missing_elec' = any(fl) then
      blocking := array_append(blocking, v_room.code);
    end if;

    if m is not null then
      if ep is not null or ec is not null then
        insert into meter_readings (round_id, room_id, kind, prev, curr, prev_units, read_by, read_by_name)
        values (v_round, v_room.id, 'elec', ep, ec, pu, me, jtext(m, 'read_by'));
      end if;
      if wp is not null or wc is not null then
        insert into meter_readings (round_id, room_id, kind, prev, curr, read_by, read_by_name)
        values (v_round, v_room.id, 'water', wp, wc, me, jtext(m, 'read_by'));
      end if;
    end if;

    insert into bills (round_id, room_id, tenant_name, tenant_phone, status, rent,
                       elec_prev, elec_curr, elec_units, elec_rate, elec_amount,
                       water_prev, water_curr, water_units, water_rate, water_amount, water_is_flat,
                       service, discount, flags)
    values (v_round, v_room.id,
            coalesce(jtext(r, 'tenant_name'), (select name from tenants where room_id = v_room.id and active)),
            coalesce(jtext(r, 'tenant_phone'), (select phone from tenants where room_id = v_room.id and active)),
            case v_room.status when 'staff' then 'welfare' when 'occupied' then 'open' else 'vacant' end,
            case when billable then v_room.base_rent else 0 end,
            ep, ec, eu, e_rate,
            case when billable and eu > 0 then round(eu * e_rate, 2) else 0 end,
            wp, wc, wu, (v_rates->>'water')::numeric,
            case when not billable then 0
                 when w_flat is not null then w_flat
                 when wu > 0 then round(wu * (v_rates->>'water')::numeric, 2)
                 else 0 end,
            billable and w_flat is not null,
            case when billable then v_room.service_fee else 0 end,
            case when billable then v_room.recurring_discount else 0 end,
            fl);
  end loop;

  -- ---------------------------------------------------------------- unknown rooms in the meter sheet
  for m in select value from jsonb_array_elements(coalesce(payload->'meters', '[]')) loop
    if jtext(m, 'code') is not null and not (jtext(m, 'code') = any(seen)) then
      warnings := warnings || jsonb_build_object('sheet', 'จดมิเตอร์', 'room', jtext(m, 'code'),
                                                 'message', 'ไม่พบห้องนี้ในแท็บห้องและผู้เช่า — ไม่ได้นำเข้า');
    end if;
  end loop;

  -- ---------------------------------------------------------------- one-off items
  for it in select value from jsonb_array_elements(coalesce(payload->'items', '[]')) loop
    if jtext(it, 'code') is null or coalesce(jnum(it, 'amount'), 0) = 0 then continue; end if;
    select b.id into v_bill from bills b join rooms ro on ro.id = b.room_id
     where b.round_id = v_round and ro.code = jtext(it, 'code');
    if v_bill is null then
      warnings := warnings || jsonb_build_object('sheet', 'รายการเพิ่มรอบนี้', 'room', jtext(it, 'code'),
                    'amount', jnum(it, 'amount'), 'message', 'ไม่พบห้องนี้ — ไม่ได้นำเข้า');
      continue;
    end if;
    insert into bill_items (bill_id, description, amount, source, created_by, reason)
    values (v_bill, coalesce(jtext(it, 'description'), 'รายการเพิ่ม'), jnum(it, 'amount'), 'import', me, jtext(it, 'note'));
  end loop;

  -- ---------------------------------------------------------------- carry-in arrears
  for it in select value from jsonb_array_elements(coalesce(payload->'carry', '[]')) loop
    if jtext(it, 'code') is null or coalesce(jnum(it, 'amount'), 0) = 0 then continue; end if;
    select b.id into v_bill from bills b join rooms ro on ro.id = b.room_id
     where b.round_id = v_round and ro.code = jtext(it, 'code');
    if v_bill is null then
      warnings := warnings || jsonb_build_object('sheet', 'ยอดค้างยกมา', 'room', jtext(it, 'code'),
                    'amount', jnum(it, 'amount'), 'message', 'ไม่พบห้องนี้ — ยอดค้างไม่ได้นำเข้า ตรวจชื่อห้องให้ตรงแท็บห้องและผู้เช่า');
      continue;
    end if;
    update bills set carry_in = carry_in + jnum(it, 'amount') where id = v_bill;
  end loop;

  -- items_total, and vacant rooms that still owe something become receivable
  update bills b set items_total = coalesce((select sum(amount) from bill_items i where i.bill_id = b.id), 0)
   where b.round_id = v_round;
  update bills set status = 'open' where round_id = v_round and status = 'vacant' and total <> 0;

  -- ---------------------------------------------------------------- workers (match by unique phone, then by name)
  for w in select value from jsonb_array_elements(coalesce(payload->'workers', '[]')) loop
    w_name := regexp_replace(coalesce(jtext(w, 'full_name'), ''), '\s*\(ใส่.*\)\s*$', '');
    w_nid := nullif(regexp_replace(coalesce(w->>'national_id', ''), '\D', '', 'g'), '');
    if w_name = '' or (w_name ~ 'ใส่ชื่อ' and w_nid is null) then continue; end if;
    w_phone := nullif(regexp_replace(coalesce(w->>'phone', ''), '\D', '', 'g'), '');
    if w_nid is not null and not thai_id_ok(w_nid) then
      warnings := warnings || jsonb_build_object('sheet', 'ช่างและแม่บ้าน', 'room', w_name,
                    'message', 'เลขบัตรประชาชนไม่ถูกต้อง — ไม่ได้บันทึกเลขบัตร');
      w_nid := null;
    end if;
    -- phone first (SPEC §8.1), but a phone shared by two people (known case: เต้/แม็ค) must not merge them:
    -- when the name points at a different worker than the phone does, the name wins.
    select id into w_by_name from workers
     where full_name = w_name or split_part(regexp_replace(full_name, '\(.*$', ''), ' ', 1) = split_part(regexp_replace(w_name, '\(.*$', ''), ' ', 1)
     order by (full_name = w_name) desc limit 1;
    w_match := null;
    if w_phone is not null then
      select count(*), min(id::text)::uuid into w_cnt, w_match from workers where phone = w_phone;
      if w_cnt <> 1 then w_match := null; end if;
    end if;
    if w_by_name is not null and w_match is distinct from w_by_name then
      w_match := w_by_name;
    end if;
    if w_match is not null then
      update workers set full_name = w_name,
                         kind = coalesce(jtext(w, 'kind'), kind),
                         daily_rate = coalesce(jnum(w, 'daily_rate'), daily_rate),
                         phone = coalesce(w_phone, phone),
                         national_id = coalesce(w_nid, national_id)
       where id = w_match;
      w_updated := w_updated + 1;
    else
      insert into workers (full_name, kind, daily_rate, phone, national_id)
      values (w_name, coalesce(jtext(w, 'kind'), 'technician'),
              coalesce(jnum(w, 'daily_rate'), case when jtext(w, 'kind') = 'maid' then 350 else 400 end), w_phone, w_nid);
      w_added := w_added + 1;
    end if;
  end loop;

  select jsonb_build_object(
    'round_id', v_round,
    'label', v_label,
    'rooms', count(*),
    'flagged', count(*) filter (where cardinality(b.flags) > 0),
    'blocking', to_jsonb(blocking),
    'warnings', warnings,
    'workers_added', w_added,
    'workers_updated', w_updated,
    'totals', jsonb_build_object(
      'N', coalesce(sum(b.total) filter (where ro.building_id = 'N' and b.status <> 'vacant'), 0),
      'P', coalesce(sum(b.total) filter (where ro.building_id = 'P' and b.status <> 'vacant'), 0),
      'all', coalesce(sum(b.total) filter (where b.status <> 'vacant'), 0),
      'rent', coalesce(sum(b.rent), 0),
      'elec', coalesce(sum(b.elec_amount), 0),
      'water', coalesce(sum(b.water_amount), 0),
      'service', coalesce(sum(b.service), 0),
      'discount', coalesce(sum(b.discount), 0),
      'items', coalesce(sum(b.items_total), 0),
      'carry', coalesce(sum(b.carry_in), 0)))
  into result
  from bills b join rooms ro on ro.id = b.room_id
  where b.round_id = v_round;
  return result;
end $$;

-- ================================================================ issue_round
create or replace function issue_round(p_round uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rd bill_rounds%rowtype;
  blockers text;
  n int;
begin
  perform require_role('manager', 'finance_field');
  select * into rd from bill_rounds where id = p_round for update;
  if not found then raise exception using message = 'ไม่พบรอบบิล'; end if;
  if rd.status <> 'draft' then
    raise exception using message = format('รอบบิล %s วางบิลไปแล้ว', rd.label);
  end if;

  select string_agg(ro.code, ', ' order by ro.code) into blockers
    from bills b join rooms ro on ro.id = b.room_id
   where b.round_id = p_round and ro.status = 'occupied' and 'missing_elec' = any(b.flags);
  if blockers is not null then
    raise exception using message = format('ยังไม่จดไฟ: %s — จดให้ครบก่อนวางบิล', blockers);
  end if;

  -- tenants approved after the import appear on the bill
  update bills b set tenant_name = t.name, tenant_phone = t.phone
    from tenants t
   where b.round_id = p_round and t.room_id = b.room_id and t.active and b.tenant_name is null;

  update bill_rounds set status = 'issued', issue_date = coalesce(issue_date, today_th()),
         issued_by = auth.uid(), issued_at = now()
   where id = p_round;

  -- staff room: non-cash pair so NOI is unchanged (SPEC §4.6)
  insert into ledger_entries (on_date, wallet_id, amount, category, project_id, ref_table, ref_id, description, created_by)
  select coalesce(rd.issue_date, today_th()), 'NONCASH', s.amt, s.cat, ro.building_id, 'bills', b.id,
         format('%s ห้อง %s %s', s.label, ro.code, rd.label), auth.uid()
    from bills b join rooms ro on ro.id = b.room_id
    cross join lateral (values (b.total, 'staff_room', 'ค่าห้องพนักงาน'),
                               (-b.total, 'welfare_housing', 'สวัสดิการที่พักพนักงาน')) s(amt, cat, label)
   where b.round_id = p_round and b.status = 'welfare' and b.total <> 0;

  select count(*) into n from bills where round_id = p_round and status = 'open';
  return jsonb_build_object('round_id', p_round, 'open_bills', n);
end $$;

-- ================================================================ helpers for one bill
create or replace function lock_bill(p_bill uuid, out b bills, out rd bill_rounds, out ro rooms)
language plpgsql security definer set search_path = public as $$
begin
  select * into b from bills where id = p_bill for update;
  if not found then raise exception using message = 'ไม่พบบิล'; end if;
  select * into rd from bill_rounds where id = b.round_id;
  select * into ro from rooms where id = b.room_id;
end $$;

-- re-derive open/closed after a change in total or paid
create or replace function settle_bill_status(p_bill uuid) returns text
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  update bills set status = case
      when status in ('welfare') then status
      when status = 'vacant' and total = 0 then 'vacant'
      when paid >= total and total > 0 then 'closed'
      when paid >= total and total <= 0 and paid > 0 then 'closed'
      else 'open' end
   where id = p_bill
   returning status into s;
  return s;
end $$;

-- ================================================================ add_bill_item (adjustment)
create or replace function add_bill_item(p_bill uuid, p_description text, p_amount numeric, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare x record; s text;
begin
  perform require_role('finance');
  select * into x from lock_bill(p_bill);
  if (x.rd).status = 'closed' then raise exception using message = 'รอบบิลปิดแล้ว แก้ไขไม่ได้'; end if;
  if coalesce(btrim(p_description), '') = '' then raise exception using message = 'ใส่ชื่อรายการ'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception using message = 'ใส่จำนวนเงิน (+ เก็บเพิ่ม / − ส่วนลด)'; end if;
  if (x.rd).status = 'issued' and coalesce(btrim(p_reason), '') = '' then
    raise exception using message = 'วางบิลแล้ว ต้องใส่เหตุผลของการปรับ';
  end if;
  if (x.b).total + p_amount < (x.b).paid then
    raise exception using message = format('ปรับแล้วยอดบิล (%s) จะน้อยกว่าที่รับเงินไปแล้ว (%s)',
      to_char((x.b).total + p_amount, 'FM999,999,990.00'), to_char((x.b).paid, 'FM999,999,990.00'));
  end if;
  insert into bill_items (bill_id, description, amount, source, created_by, reason)
  values (p_bill, btrim(p_description), p_amount, 'adjustment', auth.uid(), nullif(btrim(p_reason), ''));
  update bills set items_total = items_total + p_amount where id = p_bill;
  s := settle_bill_status(p_bill);
  return jsonb_build_object('bill_id', p_bill, 'status', s);
end $$;

-- ================================================================ add_penalty
create or replace function add_penalty(p_bill uuid, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x record; cap numeric; s text;
begin
  perform require_role('finance_field', 'manager');
  select * into x from lock_bill(p_bill);
  if (x.rd).status <> 'issued' then raise exception using message = 'ใส่ค่าปรับได้หลังวางบิลเท่านั้น'; end if;
  if (x.b).status <> 'open' then raise exception using message = 'บิลนี้ไม่ได้ค้างชำระ'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่ค่าปรับ'; end if;
  cap := coalesce(((x.rd).rates->>'pen_max')::numeric, 3100);
  if (x.b).penalty + p_amount > cap then
    raise exception using message = format('ค่าปรับรวมเกินเพดาน %s บาท (ใส่ไปแล้ว %s)',
      to_char(cap, 'FM999,999,990'), to_char((x.b).penalty, 'FM999,999,990'));
  end if;
  update bills set penalty = penalty + p_amount where id = p_bill;
  s := settle_bill_status(p_bill);
  return jsonb_build_object('bill_id', p_bill, 'status', s);
end $$;

-- suggested penalty = min(max, days_late × per_day)
create or replace function suggested_penalty(p_bill uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select least(coalesce((rd.rates->>'pen_max')::numeric, 3100),
               greatest(0, today_th() - rd.due_date) * coalesce((rd.rates->>'pen_day')::numeric, 100)) - b.penalty
    from bills b join bill_rounds rd on rd.id = b.round_id
   where b.id = p_bill and is_staff()
$$;

-- ================================================================ record_receipt
create or replace function record_receipt(p_bill uuid, p_amount numeric, p_on_date date, p_slip_path text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare x record; remaining numeric; rid uuid; w text; s text;
begin
  perform require_role('finance');
  select * into x from lock_bill(p_bill);
  if (x.rd).status <> 'issued' then raise exception using message = 'รับเงินได้หลังวางบิลเท่านั้น'; end if;
  if (x.b).status <> 'open' then
    raise exception using message = case (x.b).status when 'closed' then format('ห้อง %s ปิดรอบนี้แล้ว', (x.ro).code)
                                       when 'welfare' then 'ห้องพนักงาน ไม่ต้องรับเงิน'
                                       else 'บิลนี้ไม่ได้ค้างชำระ' end;
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่จำนวนเงินที่ได้รับ'; end if;
  remaining := (x.b).total - (x.b).paid;
  if p_amount > remaining then
    raise exception using message = format('รับเกินยอดค้าง (ค้าง %s บาท) — ส่วนเกินให้บันทึกเป็นเงินประกันหรือหมายเหตุ',
      to_char(remaining, 'FM999,999,990.00'));
  end if;
  w := wallet_for_building((x.ro).building_id);
  insert into receipts (bill_id, amount, received_on, wallet_id, slip_path, recorded_by)
  values (p_bill, p_amount, coalesce(p_on_date, today_th()), w, p_slip_path, auth.uid())
  returning id into rid;
  insert into ledger_entries (on_date, wallet_id, amount, category, project_id, ref_table, ref_id, description, created_by)
  values (coalesce(p_on_date, today_th()), w, p_amount, 'rent_receipt', (x.ro).building_id, 'receipts', rid,
          format('รับค่าห้อง %s %s', (x.ro).code, (x.rd).label), auth.uid());
  update bills set paid = paid + p_amount where id = p_bill;
  s := settle_bill_status(p_bill);
  return jsonb_build_object('bill_id', p_bill, 'status', s, 'remaining', remaining - p_amount, 'receipt_id', rid);
end $$;

-- ================================================================ record_deposit
create or replace function record_deposit(p_room_code text, p_kind text, p_amount numeric, p_on_date date,
                                          p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare ro rooms%rowtype; held numeric; did uuid; w text; tname text;
begin
  perform require_role('finance');
  select * into ro from rooms where code = btrim(p_room_code) for update;
  if not found then raise exception using message = format('ไม่พบห้อง %s', p_room_code); end if;
  if p_kind not in ('deposit', 'booking', 'refund') then raise exception using message = 'ประเภทไม่ถูกต้อง'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่จำนวนเงิน'; end if;
  select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) into held
    from deposits where room_id = ro.id;
  if p_kind = 'refund' and p_amount > held then
    raise exception using message = format('ห้อง %s ถือเงินประกันอยู่ %s บาท คืนเกินไม่ได้', ro.code,
      to_char(held, 'FM999,999,990.00'));
  end if;
  w := wallet_for_building(ro.building_id);
  select name into tname from tenants where room_id = ro.id and active;
  insert into deposits (room_id, tenant_name, kind, amount, wallet_id, on_date, recorded_by, note)
  values (ro.id, tname, p_kind, p_amount, w, coalesce(p_on_date, today_th()), auth.uid(), p_note)
  returning id into did;
  insert into ledger_entries (on_date, wallet_id, amount, category, project_id, ref_table, ref_id, description, created_by)
  values (coalesce(p_on_date, today_th()), w, case when p_kind = 'refund' then -p_amount else p_amount end,
          case when p_kind = 'refund' then 'deposit_refund' else 'deposit' end, ro.building_id, 'deposits', did,
          format('%s ห้อง %s', case p_kind when 'deposit' then 'เงินประกัน' when 'booking' then 'เงินจอง' else 'คืนเงินประกัน' end, ro.code),
          auth.uid());
  return jsonb_build_object('deposit_id', did, 'held', held + case when p_kind = 'refund' then -p_amount else p_amount end);
end $$;

-- ================================================================ views
create view wallet_balances with (security_invoker) as
  select wallet_id, sum(amount) as balance from ledger_entries group by wallet_id;

create view v_deposits_held with (security_invoker) as
  select ro.building_id, ro.code as room_code, d.room_id,
         sum(case when d.kind = 'refund' then -d.amount else d.amount end) as held
    from deposits d join rooms ro on ro.id = d.room_id
   group by ro.building_id, ro.code, d.room_id;

create view v_round_summary with (security_invoker) as
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
         coalesce(sum(b.penalty), 0) as penalty, coalesce(sum(b.carry_in), 0) as carry_in
    from bills b join rooms ro on ro.id = b.room_id
   group by b.round_id, ro.building_id;

grant select on wallet_balances, v_deposits_held, v_round_summary to authenticated;

grant execute on function import_round(jsonb), issue_round(uuid), add_bill_item(uuid, text, numeric, text),
  add_penalty(uuid, numeric), suggested_penalty(uuid), record_receipt(uuid, numeric, date, text),
  record_deposit(text, text, numeric, date, text), thai_id_ok(text) to authenticated;
