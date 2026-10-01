-- Settings, users, tenant registration, alerts (SPEC §3, §4.6 tenant registration, §4.9)

-- ================================================================ settings
create or replace function update_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('finance');
  if p_key not in ('rates', 'repair_reserve', 'privacy_notice_version', 'site_radius_m') then
    raise exception using message = format('ไม่รู้จักค่าตั้ง %s', p_key);
  end if;
  insert into settings (key, value, updated_by, updated_at) values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
end $$;

create or replace function update_building(p_id text, p_bill_name text, p_bank_name text, p_account_name text,
                                           p_account_no text, p_contact text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('finance');
  update buildings set bill_name = nullif(btrim(p_bill_name), ''), bank_name = nullif(btrim(p_bank_name), ''),
         bank_account_name = nullif(btrim(p_account_name), ''), bank_account_no = nullif(btrim(p_account_no), ''),
         contact_phone = nullif(btrim(p_contact), '')
   where id = p_id;
  if not found then raise exception using message = 'ไม่พบอาคาร'; end if;
end $$;

-- petty cash opening balance: asked from นุ้ย at go-live (SPEC §4.1). Once only.
create or replace function set_opening_balance(p_wallet text, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('finance');
  if p_wallet <> 'PC' then raise exception using message = 'ตั้งยอดยกมาได้เฉพาะเงินสำรองนุ้ย'; end if;
  if p_amount is null or p_amount < 0 then raise exception using message = 'ใส่ยอดเงินสำรองที่นับได้จริง'; end if;
  perform 1 from wallets where id = p_wallet for update;
  if exists (select 1 from ledger_entries where wallet_id = p_wallet and category = 'opening_balance') then
    raise exception using message = 'ตั้งยอดยกมาไปแล้ว — ถ้าผิดให้บันทึกรายการปรับปรุง';
  end if;
  insert into ledger_entries (on_date, wallet_id, amount, category, description, created_by)
  values (date '2026-09-30', p_wallet, p_amount, 'opening_balance', 'ยอดยกมา เงินสำรองนุ้ย (นับจริงวันเริ่มระบบ)', auth.uid());
end $$;

-- ================================================================ users (profile edits; account creation is the admin-create-user edge function)
create or replace function admin_update_profile(p_id uuid, p_display_name text, p_role role_t, p_active boolean,
                                                p_worker_id uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare me role_t := require_role('finance', 'manager'); cur profiles%rowtype;
begin
  select * into cur from profiles where id = p_id for update;
  if not found then raise exception using message = 'ไม่พบผู้ใช้'; end if;
  if p_id = auth.uid() and (p_role <> cur.role or not p_active) then
    raise exception using message = 'เปลี่ยนสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้';
  end if;
  if me <> 'ceo' and (cur.role = 'ceo' or p_role = 'ceo') then
    raise exception using message = 'เฉพาะ CEO เปลี่ยนสิทธิ์ระดับ CEO ได้';
  end if;
  if me = 'manager' and (cur.role <> 'worker' or p_role <> 'worker') then
    raise exception using message = 'ผู้จัดการแก้ได้เฉพาะบัญชีช่าง/แม่บ้าน';
  end if;
  update profiles set display_name = btrim(p_display_name), role = p_role, active = p_active,
         worker_id = coalesce(p_worker_id, worker_id)
   where id = p_id;
end $$;

create or replace function accept_consent(p_version text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception using message = 'กรุณาเข้าสู่ระบบก่อน'; end if;
  update profiles set consent_at = now(), consent_version = p_version where id = auth.uid();
end $$;

-- ================================================================ tenant registration (public form, no login)
-- what the public form may know about a room: building name and room code only — never the current tenant
create or replace function registration_room(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('room', ro.code, 'building', coalesce(b.bill_name, b.name),
           'notice_version', coalesce((select value->>'version' from settings where key = 'privacy_notice_version'), '1'),
           'has_pending', exists (select 1 from tenant_registrations t where t.room_id = ro.id and t.status = 'pending'))
    from rooms ro join buildings b on b.id = ro.building_id
   where ro.reg_token = p_token
$$;

create or replace function submit_tenant_registration(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ro rooms%rowtype; v_phone text; v_ephone text; recent int; rid uuid;
begin
  select * into ro from rooms where reg_token = p_token for update;
  if not found then raise exception using message = 'ลิงก์ไม่ถูกต้อง — ขอลิงก์ใหม่จากหอพัก'; end if;

  -- rate limit: at most 5 submissions per room per 24 h, one pending at a time
  select count(*) into recent from tenant_registrations where room_id = ro.id and created_at > now() - interval '24 hours';
  if recent >= 5 then raise exception using message = 'ส่งข้อมูลบ่อยเกินไป กรุณาลองใหม่พรุ่งนี้ หรือติดต่อหอพัก'; end if;
  if exists (select 1 from tenant_registrations where room_id = ro.id and status = 'pending') then
    raise exception using message = 'ห้องนี้มีข้อมูลรอเจ้าหน้าที่ตรวจอยู่แล้ว กรุณาติดต่อหอพัก';
  end if;

  v_phone := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  v_ephone := regexp_replace(coalesce(p->>'emergency_phone', ''), '\D', '', 'g');
  if length(btrim(coalesce(p->>'name', ''))) < 3 then raise exception using message = 'กรุณากรอกชื่อ-นามสกุล'; end if;
  if v_phone !~ '^0[0-9]{8,9}$' then raise exception using message = 'เบอร์โทรไม่ถูกต้อง'; end if;
  if length(btrim(coalesce(p->>'emergency_name', ''))) < 2 or v_ephone !~ '^0[0-9]{8,9}$' then
    raise exception using message = 'กรุณากรอกชื่อและเบอร์ผู้ติดต่อฉุกเฉิน';
  end if;
  if coalesce((p->>'accepted')::boolean, false) is not true then
    raise exception using message = 'กรุณาอ่านและยอมรับประกาศความเป็นส่วนตัว';
  end if;

  insert into tenant_registrations (room_id, name, phone, line_id, emergency_name, emergency_phone, notice_version, accepted_at)
  values (ro.id, left(btrim(p->>'name'), 120), v_phone, left(nullif(btrim(p->>'line_id'), ''), 60),
          left(btrim(p->>'emergency_name'), 120), v_ephone,
          coalesce((select value->>'version' from settings where key = 'privacy_notice_version'), '1'), now())
  returning id into rid;
  return jsonb_build_object('ok', true);
end $$;

create or replace function decide_tenant_registration(p_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare reg tenant_registrations%rowtype;
begin
  perform require_role('finance_field', 'finance');
  select * into reg from tenant_registrations where id = p_id for update;
  if not found then raise exception using message = 'ไม่พบรายการ'; end if;
  if reg.status <> 'pending' then raise exception using message = 'รายการนี้ตรวจไปแล้ว'; end if;
  update tenant_registrations set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
   where id = p_id;
  if p_approve then
    update tenants set active = false, move_out = coalesce(move_out, today_th()) where room_id = reg.room_id and active;
    insert into tenants (room_id, name, phone, line_id, emergency_name, emergency_phone, move_in, source)
    values (reg.room_id, reg.name, reg.phone, reg.line_id, reg.emergency_name, reg.emergency_phone, today_th(), 'registration');
    -- show on bills of rounds still in draft
    update bills b set tenant_name = reg.name, tenant_phone = reg.phone
      from bill_rounds rd
     where rd.id = b.round_id and rd.status = 'draft' and b.room_id = reg.room_id;
  end if;
end $$;

create or replace function regenerate_room_token(p_room uuid) returns text
language plpgsql security definer set search_path = public as $$
declare t text := replace(gen_random_uuid()::text, '-', '');
begin
  perform require_role('finance_field', 'finance');
  update rooms set reg_token = t where id = p_room;
  return t;
end $$;

-- ================================================================ alerts (computed, SPEC §4.9 — billing set for M1)
create or replace function current_round_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from bill_rounds order by due_date desc, created_at desc limit 1
$$;

create or replace function get_alerts()
returns table (level text, kind text, title text, detail text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  rd bill_rounds%rowtype;
  late int;
  pen numeric;
  cash numeric;
  dep numeric;
  reserve numeric;
  pend_a3 numeric;
  rec record;
  flag_th constant jsonb := '{"missing_elec":"ยังไม่จดไฟ","missing_water":"ยังไม่จดน้ำ","elec_decreased":"เลขไฟลดลง",
    "water_decreased":"เลขน้ำลดลง","occupied_zero_use":"มีผู้เช่าแต่ไม่ใช้ไฟ","over_2x_last_month":"ใช้ไฟเกิน 2 เท่าของเดือนก่อน",
    "vacant_has_use":"ห้องว่างแต่มีการใช้ไฟ/น้ำ"}';
begin
  if my_role() not in ('ceo', 'finance', 'auditor', 'finance_field', 'manager') or my_role() is null then
    return;
  end if;
  select * into rd from bill_rounds where id = current_round_id();
  if found then
    late := greatest(0, today_th() - rd.due_date);
    pen := least(coalesce((rd.rates->>'pen_max')::numeric, 3100), late * coalesce((rd.rates->>'pen_day')::numeric, 100));

    -- overdue rent per building
    if rd.status = 'issued' then
      for rec in
        select ro.building_id, b2.name as bname, count(*) n, sum(b.total - b.paid) amt,
               string_agg(ro.code || ' (' || to_char(b.total - b.paid, 'FM999,999,990') ||
                          case when b.paid > 0 then ' จ่ายบางส่วน' else '' end || ')', ', ' order by ro.code) rooms
          from bills b join rooms ro on ro.id = b.room_id join buildings b2 on b2.id = ro.building_id
         where b.round_id = rd.id and b.status = 'open'
         group by ro.building_id, b2.name
      loop
        level := case when late > 0 then 'high' else 'mid' end;
        kind := 'overdue_rent';
        title := format('%s: ค่าเช่ายังไม่เข้า %s ห้อง · %s บาท', rec.bname, rec.n, to_char(rec.amt, 'FM999,999,990'));
        detail := rec.rooms || case when late > 0
                    then format(' · เลยกำหนด %s วัน ค่าปรับตามกฎ %s/ห้อง', late, to_char(pen, 'FM999,999,990')) else '' end;
        amount := rec.amt;
        return next;
      end loop;
    end if;

    -- vacant rooms + lost rent / month
    for rec in
      select b2.name as bname, count(*) n, sum(ro.base_rent) lost, string_agg(ro.code, ', ' order by ro.code) rooms
        from bills b join rooms ro on ro.id = b.room_id join buildings b2 on b2.id = ro.building_id
       where b.round_id = rd.id and ro.status in ('vacant', 'renovation')
       group by b2.name
    loop
      level := 'mid'; kind := 'vacant';
      title := format('%s: ห้อง/พื้นที่ว่าง %s รายการ · เสียโอกาส ~%s/เดือน', rec.bname, rec.n, to_char(rec.lost, 'FM999,999,990'));
      detail := rec.rooms; amount := rec.lost;
      return next;
    end loop;

    -- meter flags in this round
    select count(*) n,
           string_agg(ro.code || ' (' || (select string_agg(coalesce(flag_th->>f, f), ', ') from unnest(b.flags) f) || ')',
                      ' · ' order by ro.code) rooms
      into rec
      from bills b join rooms ro on ro.id = b.room_id
     where b.round_id = rd.id and cardinality(b.flags) > 0;
    if rec.n > 0 then
      level := case when rd.status = 'draft' then 'high' else 'mid' end; kind := 'meter';
      title := format('มิเตอร์ต้องตรวจ %s ห้อง%s', rec.n, case when rd.status = 'draft' then ' — ก่อนวางบิล' else '' end);
      detail := rec.rooms; amount := null;
      return next;
    end if;
  end if;

  -- incomplete worker registry / duplicate phones
  select count(*) n, string_agg(full_name, ', ') names into rec from workers
   where active and (national_id is null or not thai_id_ok(national_id) or id_card_path is null
                     or phone !~ '^0[0-9]{9}$' or full_name ~ 'ใส่ชื่อ|ยังไม่ใส่');
  if rec.n > 0 then
    level := 'mid'; kind := 'worker_registry';
    title := format('คนงานข้อมูลไม่ครบ %s คน — ยังเบิกค่าแรงให้ไม่ได้', rec.n);
    detail := rec.names; amount := null;
    return next;
  end if;
  for rec in select phone, string_agg(full_name, ' และ ') names from workers where active and phone is not null
              group by phone having count(*) > 1 loop
    level := 'mid'; kind := 'duplicate_phone';
    title := 'เบอร์โทรซ้ำกันในทะเบียนคนงาน';
    detail := rec.names || ' ใช้เบอร์เดียวกัน — ตรวจว่าเป็นคนเดียวกันหรือไม่'; amount := null;
    return next;
  end loop;

  -- pending tenant registrations
  select count(*) n, string_agg(ro.code, ', ') rooms into rec
    from tenant_registrations t join rooms ro on ro.id = t.room_id where t.status = 'pending';
  if rec.n > 0 then
    level := 'mid'; kind := 'tenant_registration';
    title := format('ผู้เช่าลงทะเบียนรอตรวจ %s ห้อง', rec.n); detail := rec.rooms; amount := null;
    return next;
  end if;

  -- dorm cash vs deposits + reserve + pending A3 payables (finance view only)
  if my_role() in ('ceo', 'finance', 'auditor') then
    select coalesce(sum(amount), 0) into cash from ledger_entries where wallet_id in ('N', 'P', 'A3');
    select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) into dep from deposits;
    reserve := coalesce((select (value->>'amount')::numeric from settings where key = 'repair_reserve'), 50000);
    select coalesce(sum(total), 0) into pend_a3 from requests where wallet_id = 'A3' and status in ('to_approve', 'to_pay');
    if cash < dep + reserve + pend_a3 then
      level := 'high'; kind := 'cash_cover';
      title := format('เงินใน 3 บัญชี %s ไม่พอคุ้มเงินประกันผู้เช่า + สำรอง + รายการรอจ่าย (%s)',
                      to_char(cash, 'FM999,999,990'), to_char(dep + reserve + pend_a3, 'FM999,999,990'));
      detail := 'ยังไม่ควรโอนให้เจ้าของจนกว่าจะเก็บค่าเช่าค้างได้'; amount := dep + reserve + pend_a3 - cash;
      return next;
    end if;
  end if;
end $$;

create view v_alerts as select * from get_alerts();
grant select on v_alerts to authenticated;

grant execute on function update_setting(text, jsonb), update_building(text, text, text, text, text, text),
  set_opening_balance(text, numeric), admin_update_profile(uuid, text, role_t, boolean, uuid), accept_consent(text),
  decide_tenant_registration(uuid, boolean, text), regenerate_room_token(uuid), current_round_id(), get_alerts()
  to authenticated;
grant execute on function registration_room(text), submit_tenant_registration(text, jsonb) to anon, authenticated;

-- ================================================================ realtime (SPEC §6)
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  alter publication supabase_realtime add table bills, receipts, bill_rounds, meter_readings, requests,
    request_events, attendance, ledger_entries, workers, deposits, bill_items, tenant_registrations, profiles;
end $$;
