-- Found by the end-to-end run on a real Supabase stack: hosted Supabase loads pg_safeupdate for API requests, which
-- rejects any UPDATE/DELETE without a WHERE clause. The Excel import's "names/bank on the bill" update had none, so
-- importing a round failed with "UPDATE requires a WHERE clause". Same function body, plus `where true`.
-- (import_round → import_round_core → wrapped by import_round_keep → import_round; only the innermost changes.)
create or replace function import_round_core(payload jsonb) returns jsonb
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
    contact_phone     = coalesce(jtext(st, 'contact'), b.contact_phone)
  where true;   -- hosted Supabase rejects UPDATE without WHERE (pg_safeupdate) for API calls

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
