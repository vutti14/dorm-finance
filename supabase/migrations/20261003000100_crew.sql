-- M3 — crew: check-in / check-out with selfie + GPS, auto wage claims, material claims, team mode,
-- offline-safe (idempotent client_ref), เป้อ "ยืนยันงานวันนี้" confirm-all (SPEC §4.8).

-- ================================================================ schema additions
alter table attendance
  add column client_ref text unique,
  add column checkout_client_ref text unique,
  add column checkout_device_at timestamptz,
  add column checkout_photos text[] not null default '{}',
  add column checkout_lat double precision, add column checkout_lng double precision,
  add column checkout_accuracy_m int, add column checkout_distance_m int;

-- a wage / material claim is a request line without a request until เป้อ confirms it
alter table request_lines
  add column status text not null default 'in_request' check (status in ('claimed', 'in_request', 'rejected')),
  add column attendance_id uuid references attendance,
  add column claimant_worker_id uuid references workers,   -- material claims: who asked (worker_id stays null)
  add column receipt_path text,
  add column client_ref text unique,
  add column reject_note text,
  add column created_at timestamptz not null default now();
create index request_lines_claimed on request_lines (work_date) where status = 'claimed';

-- workers see their own material claims too
drop policy self_read on request_lines;
create policy self_read on request_lines for select to authenticated
  using ((select worker_id from profiles where id = auth.uid()) in (worker_id, claimant_worker_id));

-- now that crew check in with their phones, labor lines without a check-in are flagged (M2 setting)
update settings set value = '{"on": true}' where key = 'attendance_required';

-- ================================================================ helpers
create or replace function distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns int language sql immutable as $$
  select case when lat1 is null or lat2 is null then null else
    round(2 * 6371000 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
          + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::int end
$$;

-- the building a project's check-in is measured against: N / N503 → นารา, P → ปรายดาว, others none
create or replace function project_site(p_project text) returns text
language sql stable as $$
  select case when p_project in ('N', 'N503') then 'N' when p_project = 'P' then 'P'
              else (select building_id from projects where id = p_project and kind in ('dorm', 'capex')) end
$$;

create or replace function site_distance(p_project text, p_lat double precision, p_lng double precision) returns int
language sql stable security definer set search_path = public as $$
  select distance_m(p_lat, p_lng, b.lat, b.lng) from buildings b where b.id = project_site(p_project)
$$;

create or replace function my_worker() returns workers
language plpgsql stable security definer set search_path = public as $$
declare w workers%rowtype;
begin
  select wk.* into w from profiles p join workers wk on wk.id = p.worker_id where p.id = auth.uid() and p.active and wk.active;
  if not found then raise exception using message = 'บัญชีนี้ยังไม่ได้ผูกกับคนในทะเบียนคนงาน — ติดต่อเป้อ'; end if;
  return w;
end $$;

-- ================================================================ check_in
-- payload: {client_ref, project_id, work_note, selfie_path, lat, lng, accuracy, device_at,
--           member_ids?: [worker ids] (team lead submits for members present — the lead is included automatically),
--           worker_id?: (manager checks in on behalf of a worker without a phone)}
create or replace function check_in(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me role_t := my_role();
  lead workers%rowtype;
  targets uuid[];
  t uuid;
  v_ref text := nullif(payload->>'client_ref', '');
  v_project text := nullif(payload->>'project_id', '');
  v_lat double precision := (payload->>'lat')::double precision;
  v_lng double precision := (payload->>'lng')::double precision;
  v_dist int;
  done jsonb := '[]'; skipped jsonb := '[]';
  wname text; aid uuid; i int := 0;
  team boolean := jsonb_array_length(coalesce(payload->'member_ids', '[]')) > 0;
begin
  if me is null then raise exception using message = 'กรุณาเข้าสู่ระบบก่อน'; end if;
  -- offline queue may resend: same client_ref → same answer, nothing new written
  if v_ref is not null and exists (select 1 from attendance where client_ref = v_ref or client_ref like v_ref || ':%') then
    return jsonb_build_object('duplicate', true,
      'done', (select coalesce(jsonb_agg(w.full_name), '[]') from attendance a join workers w on w.id = a.worker_id
                where a.client_ref = v_ref or a.client_ref like v_ref || ':%'), 'skipped', '[]'::jsonb);
  end if;
  perform 1 from projects where id = v_project and active;
  if not found then raise exception using message = 'เลือกโครงการที่ไปทำงาน'; end if;
  if coalesce(btrim(payload->>'work_note'), '') = '' then raise exception using message = 'บอกว่าวันนี้ทำงานอะไร'; end if;
  if coalesce(payload->>'selfie_path', '') = '' then
    raise exception using message = case when team then 'ถ่ายรูปหมู่ให้เห็นหน้าทุกคนก่อน' else 'ถ่ายเซลฟี่กับหน้างานก่อน' end;
  end if;

  if me = 'worker' then
    lead := my_worker();
    if team then
      if not lead.is_team_lead then raise exception using message = 'ลงเวลาแทนเพื่อนได้เฉพาะหัวหน้าทีม'; end if;
      select array_agg(distinct x) into targets
        from (select lead.id x union all select (jsonb_array_elements_text(payload->'member_ids'))::uuid) s;
    else
      targets := array[lead.id];
    end if;
  elsif me in ('manager', 'ceo') then
    if nullif(payload->>'worker_id', '') is null then raise exception using message = 'เลือกคนงานที่จะลงเวลาแทน'; end if;
    targets := array[(payload->>'worker_id')::uuid];
  else
    raise exception using message = 'คุณไม่มีสิทธิ์ลงเวลางาน';
  end if;

  v_dist := site_distance(v_project, v_lat, v_lng);
  foreach t in array targets loop
    i := i + 1;
    select full_name into wname from workers where id = t and active;
    if wname is null then raise exception using message = 'ไม่พบคนงาน'; end if;
    begin
      insert into attendance (worker_id, work_date, device_at, project_id, work_note, selfie_path, lat, lng, accuracy_m, distance_m,
                              on_behalf_by, by_lead, client_ref)
      values (t, today_th(), nullif(payload->>'device_at', '')::timestamptz, v_project, btrim(payload->>'work_note'),
              payload->>'selfie_path', v_lat, v_lng, (payload->>'accuracy')::numeric::int, v_dist,
              case when me <> 'worker' then auth.uid() end,
              case when team and t <> lead.id then lead.id end,
              case when v_ref is null then null when array_length(targets, 1) = 1 then v_ref else v_ref || ':' || i end)
      returning id into aid;
      done := done || to_jsonb(wname);
    exception when unique_violation then
      if array_length(targets, 1) = 1 then
        raise exception using message = format('%s ลงเวลาวันนี้ไปแล้ว', wname);
      end if;
      skipped := skipped || jsonb_build_object('name', wname, 'message', format('%s ลงเวลาวันนี้เองแล้ว — ข้าม', wname));
    end;
  end loop;
  return jsonb_build_object('done', done, 'skipped', skipped, 'distance_m', v_dist, 'has_gps', v_lat is not null);
end $$;

-- ================================================================ check_out → auto wage claim
-- payload: {client_ref, photos: [1..5], note, work_type, room_code, lat, lng, accuracy, device_at, member_ids?, worker_id?}
create or replace function check_out(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me role_t := my_role();
  lead workers%rowtype;
  targets uuid[];
  t uuid; a attendance%rowtype; w workers%rowtype;
  v_ref text := nullif(payload->>'client_ref', '');
  photos text[];
  v_lat double precision := (payload->>'lat')::double precision;
  v_lng double precision := (payload->>'lng')::double precision;
  v_wt text := coalesce(nullif(payload->>'work_type', ''), 'routine');
  v_room text := nullif(btrim(coalesce(payload->>'room_code', '')), '');
  done jsonb := '[]'; skipped jsonb := '[]'; i int := 0;
  team boolean := jsonb_array_length(coalesce(payload->'member_ids', '[]')) > 0;
begin
  if me is null then raise exception using message = 'กรุณาเข้าสู่ระบบก่อน'; end if;
  if v_ref is not null and exists (select 1 from attendance where checkout_client_ref = v_ref or checkout_client_ref like v_ref || ':%') then
    return jsonb_build_object('duplicate', true, 'done', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  select array_agg(x) into photos from jsonb_array_elements_text(coalesce(payload->'photos', '[]')) x where x <> '';
  if coalesce(array_length(photos, 1), 0) = 0 then raise exception using message = 'ถ่ายรูปงานที่ทำเสร็จอย่างน้อย 1 รูป'; end if;
  if array_length(photos, 1) > 5 then raise exception using message = 'รูปงานได้ไม่เกิน 5 รูป'; end if;
  if coalesce(btrim(payload->>'note'), '') = '' then raise exception using message = 'บอกว่าวันนี้ทำอะไรเสร็จ'; end if;
  if v_wt not in ('routine', 'renovation', 'project') then raise exception using message = 'ประเภทงานไม่ถูกต้อง'; end if;
  if v_wt = 'renovation' and v_room is null then raise exception using message = 'งานสร้าง/ปรับปรุงห้อง ต้องใส่เลขห้อง'; end if;

  if me = 'worker' then
    lead := my_worker();
    if team then
      if not lead.is_team_lead then raise exception using message = 'ส่งงานแทนเพื่อนได้เฉพาะหัวหน้าทีม'; end if;
      select array_agg(distinct x) into targets
        from (select lead.id x union all select (jsonb_array_elements_text(payload->'member_ids'))::uuid) s;
    else
      targets := array[lead.id];
    end if;
  elsif me in ('manager', 'ceo') then
    targets := array[(payload->>'worker_id')::uuid];
  else
    raise exception using message = 'คุณไม่มีสิทธิ์ส่งงาน';
  end if;

  foreach t in array targets loop
    i := i + 1;
    select * into w from workers where id = t;
    select * into a from attendance where worker_id = t and work_date = today_th() for update;
    if not found then
      if array_length(targets, 1) = 1 then raise exception using message = format('%s ยังไม่ได้ลงเวลาเข้าวันนี้', w.full_name); end if;
      skipped := skipped || jsonb_build_object('name', w.full_name, 'message', format('%s ยังไม่ได้ลงเวลาเข้า — ข้าม', w.full_name));
      continue;
    end if;
    if a.checkout_at is not null then
      if array_length(targets, 1) = 1 then raise exception using message = format('%s ส่งงานวันนี้ไปแล้ว', w.full_name); end if;
      skipped := skipped || jsonb_build_object('name', w.full_name, 'message', format('%s ส่งงานไปแล้ว — ข้าม', w.full_name));
      continue;
    end if;
    update attendance set checkout_at = now(), checkout_note = btrim(payload->>'note'), checkout_photos = photos,
           checkout_device_at = nullif(payload->>'device_at', '')::timestamptz,
           checkout_lat = v_lat, checkout_lng = v_lng, checkout_accuracy_m = (payload->>'accuracy')::numeric::int,
           checkout_distance_m = site_distance(a.project_id, v_lat, v_lng),
           checkout_client_ref = case when v_ref is null then null when array_length(targets, 1) = 1 then v_ref else v_ref || ':' || i end
     where id = a.id;
    begin
      insert into request_lines (request_id, worker_id, description, amount, project_id, work_type, room_code, work_date,
                                 status, attendance_id, client_ref)
      values (null, t, w.full_name || ' · ' || left(btrim(payload->>'note'), 80), w.daily_rate, a.project_id, v_wt, v_room,
              a.work_date, 'claimed', a.id,
              case when v_ref is null then null when array_length(targets, 1) = 1 then v_ref else v_ref || ':' || i end);
      done := done || to_jsonb(w.full_name);
    exception when unique_violation then
      -- a lead and the worker himself (or a manual request) cannot claim the same day twice
      skipped := skipped || jsonb_build_object('name', w.full_name,
                   'message', format('ส่งงานแล้ว แต่ค่าแรงของ %s วันนี้มีในใบเบิกแล้ว — ไม่เบิกซ้ำ', w.full_name));
    end;
  end loop;
  return jsonb_build_object('done', done, 'skipped', skipped);
end $$;

-- ================================================================ material claim by a worker
-- payload: {client_ref, shop, amount, project_id, receipt_path}
create or replace function claim_material(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w workers; v_ref text := nullif(payload->>'client_ref', ''); lid uuid; amt numeric := jnum(payload, 'amount');
begin
  if my_role() is distinct from 'worker' then raise exception using message = 'ใช้สำหรับช่าง/แม่บ้าน'; end if;
  w := my_worker();
  if v_ref is not null then
    select id into lid from request_lines where client_ref = v_ref;
    if found then return jsonb_build_object('id', lid, 'duplicate', true); end if;
  end if;
  if coalesce(btrim(payload->>'shop'), '') = '' then raise exception using message = 'ใส่ชื่อร้าน / รายการ'; end if;
  if amt is null or amt <= 0 then raise exception using message = 'ใส่จำนวนเงิน'; end if;
  if coalesce(payload->>'receipt_path', '') = '' then raise exception using message = 'ถ่ายรูปใบเสร็จก่อน'; end if;
  perform 1 from projects where id = payload->>'project_id' and active;
  if not found then raise exception using message = 'เลือกโครงการ'; end if;
  insert into request_lines (request_id, worker_id, claimant_worker_id, description, amount, project_id, work_type, work_date,
                             status, receipt_path, client_ref)
  values (null, null, w.id, btrim(payload->>'shop') || ' (เบิกโดย ' || w.full_name || ')', amt, payload->>'project_id', 'routine',
          today_th(), 'claimed', payload->>'receipt_path', v_ref)
  returning id into lid;
  return jsonb_build_object('id', lid);
end $$;

-- ================================================================ เป้อ: ยืนยันงานวันนี้
-- confirm all claimed lines of a day (or the given ids) → one daily_labor request for that day, routed by total (§4.3)
create or replace function confirm_claims(p_date date, p_line_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me role_t := require_role('manager', 'finance_field');
  l record; v_total numeric := 0; n int := 0; n_worker int := 0;
  rt record; rid uuid; rno int; miss text[]; bad text := null;
  has_worker boolean;
begin
  -- lock the claims so two managers confirming at once cannot double-book them
  for l in select rl.*, w.full_name, w.id as wid from request_lines rl left join workers w on w.id = rl.worker_id
            where rl.status = 'claimed' and rl.work_date = p_date and (p_line_ids is null or rl.id = any(p_line_ids))
            order by rl.created_at for update of rl loop
    if l.wid is not null then
      miss := worker_missing((select w2 from workers w2 where w2.id = l.wid));
      if cardinality(miss) > 0 then
        bad := coalesce(bad || ', ', '') || format('%s (ขาด %s)', l.full_name, array_to_string(miss, ', '));
      end if;
      n_worker := n_worker + 1;
    end if;
    v_total := v_total + l.amount; n := n + 1;
  end loop;
  if n = 0 then raise exception using message = 'ไม่มีรายการรอยืนยันของวันนั้น (อาจมีคนยืนยันไปแล้ว)'; end if;
  if bad is not null then
    raise exception using message = format('ทะเบียนคนงานไม่ครบ: %s — แก้ที่แท็บทะเบียนคนงาน หรือกดไม่อนุมัติรายการนั้น', bad);
  end if;
  has_worker := n_worker > 0;

  rt := route_request(case when has_worker then 'daily_labor' else 'material' end, v_total);
  insert into requests (type, requester_id, work_date, status, approver_role, payer_role, wallet_id, total)
  values (case when has_worker then 'daily_labor' else 'material' end, auth.uid(), p_date, rt.status, rt.approver_role,
          rt.payer_role, rt.wallet_id, v_total)
  returning id, no into rid, rno;

  update request_lines set request_id = rid, status = 'in_request'
   where status = 'claimed' and work_date = p_date and (p_line_ids is null or id = any(p_line_ids));

  -- photos from check-out become the request's work photos; worker receipts become receipts
  insert into attachments (owner_table, owner_id, kind, path, created_by)
  select 'requests', rid, 'work', unnest(a.checkout_photos), auth.uid()
    from request_lines rl join attendance a on a.id = rl.attendance_id where rl.request_id = rid;
  insert into attachments (owner_table, owner_id, kind, path, created_by)
  select 'requests', rid, 'receipt', rl.receipt_path, auth.uid() from request_lines rl where rl.request_id = rid and rl.receipt_path is not null;

  insert into request_events (request_id, action, actor_id, note) values (rid, 'submit', auth.uid(), format('ยืนยันงาน %s รายการ', n));
  return jsonb_build_object('id', rid, 'no', rno, 'lines', n, 'total', v_total, 'status', rt.status,
                            'approver_role', rt.approver_role, 'payer_role', rt.payer_role, 'wallet_id', rt.wallet_id);
end $$;

create or replace function reject_claim(p_line uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare l request_lines%rowtype;
begin
  perform require_role('manager', 'finance_field');
  select * into l from request_lines where id = p_line for update;
  if not found or l.status <> 'claimed' then raise exception using message = 'รายการนี้ไม่ได้รอยืนยันแล้ว'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception using message = 'ใส่เหตุผลที่ไม่อนุมัติ'; end if;
  update request_lines set status = 'rejected', active = false, reject_note = btrim(p_note) where id = p_line;
end $$;

-- ================================================================ views
create view v_attendance with (security_invoker) as
  select a.*, w.full_name, w.daily_rate, p.name as project_name, lw.full_name as lead_name, ob.display_name as on_behalf_name,
         array_remove(array[
           case when a.lat is null then 'no_gps' end,
           case when a.distance_m > 300 then 'far' end,
           case when a.checkout_at is not null and a.checkout_at - a.checked_at > interval '12 hours' then 'checkout_late' end,
           case when a.checkout_at is null and a.work_date < today_th() then 'no_checkout' end,
           case when a.on_behalf_by is not null then 'on_behalf' end,
           case when a.by_lead is not null then 'by_lead' end], null) as flags
    from attendance a
    join workers w on w.id = a.worker_id
    left join projects p on p.id = a.project_id
    left join workers lw on lw.id = a.by_lead
    left join profiles ob on ob.id = a.on_behalf_by;

-- a worker's own claims with the status they care about: รอเป้อยืนยัน → รอจ่าย → จ่ายแล้ว (+ payment proof)
create or replace function my_claims(p_days int default 60)
returns table (id uuid, work_date date, description text, amount numeric, project_id text, line_status text,
               request_no int, request_status text, reject_note text, proof text[])
language sql stable security definer set search_path = public as $$
  select rl.id, rl.work_date, rl.description, rl.amount, rl.project_id, rl.status, r.no, r.status,
         coalesce(rl.reject_note, r.reject_note),
         (select array_agg(at.path) from attachments at where at.owner_table = 'requests' and at.owner_id = r.id and at.kind = 'payment_proof')
    from request_lines rl left join requests r on r.id = rl.request_id
   where (select worker_id from profiles where id = auth.uid()) in (rl.worker_id, rl.claimant_worker_id)
     and rl.work_date >= today_th() - p_days
   order by rl.work_date desc, rl.created_at desc
$$;

grant select on v_attendance to authenticated;

-- ================================================================ alerts for M3
create or replace function get_alerts_crew()
returns table (level text, kind text, title text, detail text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare rec record;
begin
  if my_role() is null or my_role() = 'worker' then return; end if;
  select count(*) n, string_agg(format('%s %s%s', w.full_name, to_char(a.work_date, 'DD/MM'),
           case when a.lat is null then ' (ไม่มีพิกัด)' else format(' (ห่าง %s ม.)', a.distance_m) end), ' · ' order by a.work_date desc) d
    into rec
    from attendance a join workers w on w.id = a.worker_id
   where a.work_date >= today_th() - 7 and (a.lat is null or a.distance_m > 300);
  if rec.n > 0 then
    level := 'high'; kind := 'checkin_gps';
    title := format('ลงเวลางานไม่มีพิกัดหรือห่างหอเกิน 300 ม. %s ครั้ง (7 วันล่าสุด)', rec.n); detail := rec.d; amount := null;
    return next;
  end if;
  select count(*) n, string_agg(format('%s %s', w.full_name, to_char(a.work_date, 'DD/MM')), ' · ') d into rec
    from attendance a join workers w on w.id = a.worker_id
   where a.work_date >= today_th() - 7 and ((a.checkout_at is null and a.work_date < today_th())
          or a.checkout_at - a.checked_at > interval '12 hours');
  if rec.n > 0 then
    level := 'mid'; kind := 'checkout_issue';
    title := format('ลงเวลาไม่ครบ (ไม่ได้ส่งงาน หรือส่งงานเกิน 12 ชม.) %s ครั้ง', rec.n); detail := rec.d; amount := null;
    return next;
  end if;
  select count(*) n, sum(amount) s, string_agg(distinct to_char(work_date, 'DD/MM'), ', ') d into rec
    from request_lines where status = 'claimed' and work_date < today_th();
  if rec.n > 0 then
    level := 'mid'; kind := 'claims_waiting';
    title := format('ค่าแรง/วัสดุรอเป้อยืนยัน %s รายการ จากวันก่อน', rec.n); detail := 'วันที่ ' || rec.d; amount := rec.s;
    return next;
  end if;
end $$;

create or replace view v_alerts as
  select * from get_alerts() union all select * from get_alerts_money() union all select * from get_alerts_crew();

grant execute on function distance_m(double precision, double precision, double precision, double precision),
  project_site(text), site_distance(text, double precision, double precision), my_worker(), check_in(jsonb), check_out(jsonb),
  claim_material(jsonb), confirm_claims(date, uuid[]), reject_claim(uuid, text), my_claims(int), get_alerts_crew()
  to authenticated;

-- team lead flag is set by managers through upsert_worker (field is_team_lead)
create or replace function set_team_lead(p_worker uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('manager', 'finance_field');
  update workers set is_team_lead = p_on where id = p_worker;
  if not found then raise exception using message = 'ไม่พบคนงาน'; end if;
end $$;
grant execute on function set_team_lead(uuid, boolean) to authenticated;

-- team lead: who can be ticked (names only), and whom the lead checked in today
create or replace function team_candidates() returns table (id uuid, full_name text, checked_in boolean, checked_out boolean, by_me boolean)
language plpgsql stable security definer set search_path = public as $$
declare lead workers;
begin
  lead := my_worker();
  if not lead.is_team_lead then return; end if;
  return query
    select w.id, w.full_name, a.id is not null, a.checkout_at is not null, a.by_lead = lead.id
      from workers w left join attendance a on a.worker_id = w.id and a.work_date = today_th()
     where w.active and w.id <> lead.id
     order by w.full_name;
end $$;
grant execute on function team_candidates() to authenticated;
