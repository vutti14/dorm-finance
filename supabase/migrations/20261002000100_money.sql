-- M2 — money: requests (เบิกเงิน) with routing, approve / pay / audit / question, salary, petty refill, transfers,
-- owner-paid expenses, owner draw, owner injection, bank checks, worker registry, CEO-account watch (SPEC §4.3–§4.10).
-- Every write is a security-definer RPC with a role check and row locks; Thai error messages.

create or replace function baht(n numeric) returns text
language sql immutable as $$ select to_char(coalesce(n, 0), 'FM999,999,990.00') $$;

-- ================================================================ schema additions
alter table requests
  add column salary_for uuid references profiles,
  add column approved_by uuid references profiles, add column approved_at timestamptz,
  add column paid_by uuid references profiles, add column paid_at timestamptz,
  add column audited_by uuid references profiles, add column audited_at timestamptz,
  add column asked_by uuid references profiles,
  add column reject_note text;

-- a rejected request must free its workers for that day again (SPEC §4.3: one worker per date across all requests)
alter table request_lines add column active boolean not null default true;
drop index one_worker_per_day;
create unique index one_worker_per_day on request_lines (worker_id, work_date) where worker_id is not null and active;

insert into settings (key, value) values
  -- M3 turns this on once crew check in with their phones; until then "no check-in" flags would fire on every line
  ('attendance_required', '{"on": false}'),
  ('petty_cash_low', '{"amount": 3000}')
on conflict (key) do nothing;

-- ================================================================ CEO-account watch (owner decision 1 ต.ค. 69)
-- เป้อ / นุ้ย may create CEO-level accounts, so every CEO-level change is logged and alerted to the CEO until acknowledged.
create table security_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('ceo_created', 'ceo_granted', 'ceo_revoked', 'ceo_disabled', 'ceo_enabled')),
  profile_id uuid references profiles on delete set null,
  display_name text,
  phone text,
  actor uuid,
  actor_name text,
  at timestamptz not null default now(),
  acknowledged_by uuid references profiles,
  acknowledged_at timestamptz
);
alter table security_events enable row level security;
alter table security_events force row level security;
grant select on security_events to authenticated;
create policy ceo_read on security_events for select to authenticated using (my_role() in ('ceo', 'auditor'));
create trigger audit_security_events after insert or update or delete on security_events
  for each row execute function audit_trigger();

create or replace function watch_ceo_accounts() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if tg_op = 'INSERT' then
    if new.role = 'ceo' then k := 'ceo_created'; end if;
  else
    if new.role = 'ceo' and old.role <> 'ceo' then k := 'ceo_granted';
    elsif old.role = 'ceo' and new.role <> 'ceo' then k := 'ceo_revoked';
    elsif new.role = 'ceo' and old.active and not new.active then k := 'ceo_disabled';
    elsif new.role = 'ceo' and not old.active and new.active then k := 'ceo_enabled';
    end if;
  end if;
  if k is not null then
    insert into security_events (kind, profile_id, display_name, phone, actor, actor_name)
    values (k, new.id, new.display_name, new.phone, auth.uid(), (select display_name from profiles where id = auth.uid()));
  end if;
  return null;
end $$;
create trigger watch_ceo after insert or update of role, active on profiles
  for each row execute function watch_ceo_accounts();

create or replace function ack_security_event(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'ceo' then raise exception using message = 'เฉพาะ CEO กดรับทราบได้'; end if;
  update security_events set acknowledged_by = auth.uid(), acknowledged_at = now()
   where id = p_id and acknowledged_at is null;
  if not found then raise exception using message = 'รายการนี้รับทราบไปแล้ว'; end if;
end $$;

-- ================================================================ worker registry (SPEC §4.5) — needed to pick workers on labor requests
create or replace function worker_missing(w workers) returns text[]
language sql stable as $$
  select array_remove(array[
    case when w.full_name is null or w.full_name ~ 'ใส่ชื่อ|ยังไม่ใส่' or length(btrim(w.full_name)) < 2 then 'ชื่อ' end,
    case when coalesce(w.phone, '') !~ '^0[0-9]{9}$' then 'เบอร์โทร' end,
    case when not thai_id_ok(w.national_id) then 'เลขบัตร' end,
    case when w.id_card_path is null then 'รูปบัตร' end], null)
$$;

-- what each worker is missing (the client cannot check the masked ID number itself)
create or replace function workers_complete() returns table (id uuid, missing text[], active boolean)
language sql stable security definer set search_path = public as $$
  select w.id, worker_missing(w), w.active from workers w where is_staff()
$$;

create or replace function upsert_worker(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me role_t := require_role('manager', 'finance_field', 'finance');
  wid uuid := nullif(p->>'id', '')::uuid;
  cur workers%rowtype;
  v_name text := btrim(coalesce(p->>'full_name', ''));
  v_phone text := nullif(regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'), '');
  v_nid text := nullif(regexp_replace(coalesce(p->>'national_id', ''), '\D', '', 'g'), '');
  v_rate numeric := jnum(p, 'daily_rate');
  v_kind text := coalesce(nullif(p->>'kind', ''), 'technician');
begin
  if length(v_name) < 2 then raise exception using message = 'ใส่ชื่อ-นามสกุล'; end if;
  if v_kind not in ('technician', 'maid') then raise exception using message = 'ประเภทต้องเป็น ช่าง หรือ แม่บ้าน'; end if;
  if v_phone is not null and v_phone !~ '^0[0-9]{9}$' then raise exception using message = 'เบอร์โทรต้องเป็นตัวเลข 10 หลัก ขึ้นต้นด้วย 0'; end if;
  if v_nid is not null and not thai_id_ok(v_nid) then raise exception using message = 'เลขบัตรประชาชนไม่ถูกต้อง ตรวจอีกครั้ง'; end if;
  if wid is null then
    if v_rate is null or v_rate <= 0 then raise exception using message = 'ใส่ค่าแรงต่อวัน'; end if;
    insert into workers (full_name, kind, daily_rate, phone, national_id, id_card_path)
    values (v_name, v_kind, v_rate, v_phone, v_nid, nullif(p->>'id_card_path', ''))
    returning id into wid;
    return wid;
  end if;
  select * into cur from workers where id = wid for update;
  if not found then raise exception using message = 'ไม่พบคนงาน'; end if;
  if v_rate is not null and v_rate <> cur.daily_rate and me <> 'ceo' then
    raise exception using message = 'ค่าแรงต่อวันแก้ได้เฉพาะ CEO';
  end if;
  update workers set full_name = v_name, kind = v_kind, daily_rate = coalesce(v_rate, daily_rate),
         phone = v_phone,
         -- an empty ID field keeps the stored number (non-finance roles only ever see it masked)
         national_id = coalesce(v_nid, national_id),
         id_card_path = coalesce(nullif(p->>'id_card_path', ''), id_card_path),
         active = coalesce((p->>'active')::boolean, active)
   where id = wid;
  return wid;
end $$;

-- ================================================================ routing (SPEC §4.3)
create or replace function route_request(p_type text, p_total numeric,
  out approver_role role_t, out payer_role role_t, out wallet_id text, out status text)
language plpgsql immutable as $$
begin
  if p_type in ('salary', 'petty_refill') or p_total > 10000 then
    approver_role := 'finance'; payer_role := 'finance'; wallet_id := 'A3'; status := 'to_approve';
  elsif p_total > 3000 then
    approver_role := 'finance'; payer_role := 'finance_field'; wallet_id := 'PC'; status := 'to_approve';
  else
    approver_role := 'finance_field'; payer_role := 'finance_field'; wallet_id := 'PC'; status := 'to_pay';
  end if;
end $$;

create or replace function wallet_balance(p_wallet text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from ledger_entries where wallet_id = p_wallet
$$;

-- ================================================================ salary (SPEC §4.4)
create or replace function salary_status(p_profile uuid default null)
returns table (profile_id uuid, display_name text, plan numeric, drawn numeric, pending numeric, remaining numeric)
language plpgsql stable security definer set search_path = public as $$
declare pid uuid := coalesce(p_profile, auth.uid()); pr profiles%rowtype; m date := date_trunc('month', today_th())::date;
begin
  if pid <> auth.uid() and my_role() not in ('ceo', 'finance', 'auditor', 'finance_field') then
    raise exception using message = 'คุณไม่มีสิทธิ์ดูเงินเดือนของคนอื่น';
  end if;
  select * into pr from profiles where id = pid;
  if not found then return; end if;
  profile_id := pid; display_name := pr.display_name;
  plan := coalesce((select monthly from salary_plans s where s.profile_id = pid),
                   (select (value->>pr.role::text)::numeric from settings where key = 'salary_defaults'), 0);
  select coalesce(sum(total) filter (where status in ('paid', 'asked', 'audited')), 0),
         coalesce(sum(total) filter (where status in ('to_approve', 'to_pay')), 0)
    into drawn, pending
    from requests r
   where r.type = 'salary' and r.salary_for = pid
     and date_trunc('month', (r.created_at at time zone 'Asia/Bangkok'))::date = m;
  remaining := plan - drawn - pending;
  return next;
end $$;

create or replace function set_salary_plan(p_profile uuid, p_monthly numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'ceo' then raise exception using message = 'เงินเดือนแก้ได้เฉพาะ CEO'; end if;
  if p_monthly is null or p_monthly < 0 then raise exception using message = 'ใส่เงินเดือนต่อเดือน'; end if;
  insert into salary_plans (profile_id, monthly) values (p_profile, p_monthly)
  on conflict (profile_id) do update set monthly = excluded.monthly;
end $$;

-- ================================================================ submit_request
create or replace function submit_request(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me role_t := require_role('manager', 'finance_field');
  v_type text := payload->>'type';
  v_date date := coalesce(nullif(payload->>'work_date', '')::date, today_th());
  ln jsonb; att jsonb;
  v_total numeric := 0;
  rt record;
  rid uuid; rno int;
  w workers%rowtype; miss text[];
  pj projects%rowtype;
  n_lines int := 0; n_worker int := 0; n_work int := 0; n_receipt int := 0;
  v_amount numeric; v_desc text; v_wt text; v_room text; v_ldate date;
  sal record; v_for uuid;
begin
  if v_type not in ('daily_labor', 'material', 'common', 'salary', 'petty_refill') then
    raise exception using message = 'ประเภทใบเบิกไม่ถูกต้อง';
  end if;
  if jsonb_array_length(coalesce(payload->'lines', '[]')) = 0 then raise exception using message = 'ยังไม่ได้ใส่รายการ'; end if;
  if v_type = 'petty_refill' and me not in ('finance_field', 'ceo') then
    raise exception using message = 'ขอเติมเงินสำรองได้เฉพาะการเงินหน้างาน';
  end if;

  select count(*) filter (where value->>'kind' = 'work'), count(*) filter (where value->>'kind' = 'receipt')
    into n_work, n_receipt from jsonb_array_elements(coalesce(payload->'attachments', '[]'));

  -- pre-validate lines and compute the total
  for ln in select value from jsonb_array_elements(payload->'lines') loop
    n_lines := n_lines + 1;
    v_amount := jnum(ln, 'amount');
    v_desc := btrim(coalesce(ln->>'description', ''));
    select * into pj from projects where id = coalesce(nullif(ln->>'project_id', ''), case when v_type in ('salary', 'petty_refill') then 'SH' end);
    if not found or not pj.active then raise exception using message = format('รายการที่ %s: เลือกโครงการ', n_lines); end if;
    if nullif(ln->>'worker_id', '') is not null then
      if v_type <> 'daily_labor' then raise exception using message = 'เลือกคนงานได้เฉพาะใบเบิกงานรายวัน'; end if;
      select * into w from workers where id = (ln->>'worker_id')::uuid;
      if not found or not w.active then raise exception using message = 'ไม่พบคนงาน'; end if;
      miss := worker_missing(w);
      if cardinality(miss) > 0 then
        raise exception using message = format('%s ข้อมูลในทะเบียนไม่ครบ (ขาด %s) — ยังเบิกค่าแรงไม่ได้', w.full_name, array_to_string(miss, ', '));
      end if;
      if v_amount is null then v_amount := w.daily_rate; end if;
      if v_amount <> w.daily_rate and me <> 'ceo' then
        raise exception using message = format('ค่าแรง %s ต้องเท่ากับอัตราในทะเบียน (%s) — แก้อัตราได้เฉพาะ CEO', w.full_name, baht(w.daily_rate));
      end if;
      n_worker := n_worker + 1;
    end if;
    if v_amount is null or v_amount <= 0 then raise exception using message = format('รายการที่ %s: ใส่จำนวนเงิน', n_lines); end if;
    if v_type not in ('salary', 'petty_refill') and length(v_desc) = 0 and nullif(ln->>'worker_id', '') is null then
      raise exception using message = format('รายการที่ %s: ใส่ชื่อรายการ', n_lines);
    end if;
    if v_type = 'common' and v_desc ~ 'ไม่ระบุ' then
      raise exception using message = 'ค่าใช้จ่ายส่วนกลางต้องแยกรายการ ไม่รับ "ไม่ระบุรายการ"';
    end if;
    if ln->>'work_type' = 'renovation' and coalesce(btrim(ln->>'room_code'), '') = '' then
      raise exception using message = 'งานสร้าง/ปรับปรุงห้อง ต้องใส่เลขห้อง';
    end if;
    v_total := v_total + v_amount;
  end loop;

  if v_type = 'daily_labor' and n_worker = 0 then raise exception using message = 'ใบเบิกงานรายวันต้องเลือกคนงานอย่างน้อย 1 คน'; end if;
  if v_type = 'daily_labor' and n_work = 0 then raise exception using message = 'แนบรูปงานวันนี้อย่างน้อย 1 รูป'; end if;
  if v_type = 'common' and n_receipt < n_lines then
    raise exception using message = format('ถ่ายใบเสร็จให้ครบ %s ใบ (1 ใบต่อ 1 รายการ)', n_lines);
  end if;
  if v_type in ('salary', 'petty_refill') and n_lines <> 1 then raise exception using message = 'ใบเบิกนี้มีได้ 1 รายการ'; end if;

  if v_type = 'salary' then
    v_for := coalesce(nullif(payload->>'salary_for', '')::uuid, auth.uid());
    if v_for <> auth.uid() and me <> 'ceo' then raise exception using message = 'เบิกเงินเดือนได้เฉพาะของตัวเอง'; end if;
    perform 1 from profiles where id = v_for for update;  -- serialise two draws by the same person
    select * into sal from salary_status(v_for);
    if sal.plan is null or sal.plan <= 0 then raise exception using message = 'ยังไม่ได้ตั้งเงินเดือน — ให้ CEO ตั้งก่อน'; end if;
    if v_total > sal.remaining then
      raise exception using message = format('เกินเงินเดือนคงเหลือ (เบิกได้อีก %s บาท)', baht(sal.remaining));
    end if;
  end if;

  rt := route_request(v_type, v_total);
  insert into requests (type, requester_id, work_date, status, approver_role, payer_role, wallet_id, total, salary_for)
  values (v_type, auth.uid(), v_date, rt.status, rt.approver_role, rt.payer_role, rt.wallet_id, v_total, v_for)
  returning id, no into rid, rno;

  for ln in select value from jsonb_array_elements(payload->'lines') loop
    w := null;
    if nullif(ln->>'worker_id', '') is not null then select * into w from workers where id = (ln->>'worker_id')::uuid; end if;
    v_ldate := coalesce(nullif(ln->>'work_date', '')::date, v_date);
    v_wt := coalesce(nullif(ln->>'work_type', ''), 'routine');
    v_room := nullif(btrim(coalesce(ln->>'room_code', '')), '');
    begin
      insert into request_lines (request_id, worker_id, description, amount, project_id, work_type, room_code, work_date)
      values (rid, w.id,
              coalesce(nullif(btrim(ln->>'description'), ''), w.full_name,
                       case v_type when 'salary' then format('เบิกเงินเดือน %s/%s (%s)', to_char(today_th(), 'MM'), extract(year from today_th())::int + 543, (select display_name from profiles where id = v_for))
                                   when 'petty_refill' then 'ขอเติมเงินสำรองนุ้ย' end),
              coalesce(jnum(ln, 'amount'), w.daily_rate),
              coalesce(nullif(ln->>'project_id', ''), 'SH'), v_wt, v_room,
              case when w.id is not null then v_ldate end);
    exception when unique_violation then
      raise exception using message = format('%s มีในใบเบิกวันที่ %s แล้ว — 1 คน เบิกได้วันละครั้ง', w.full_name, to_char(v_ldate, 'DD/MM/YYYY'));
    end;
  end loop;

  for att in select value from jsonb_array_elements(coalesce(payload->'attachments', '[]')) loop
    if att->>'kind' not in ('work', 'receipt') or coalesce(att->>'path', '') = '' then continue; end if;
    insert into attachments (owner_table, owner_id, kind, path, created_by) values ('requests', rid, att->>'kind', att->>'path', auth.uid());
  end loop;
  insert into request_events (request_id, action, actor_id) values (rid, 'submit', auth.uid());
  return jsonb_build_object('id', rid, 'no', rno, 'status', rt.status, 'total', v_total,
                            'approver_role', rt.approver_role, 'payer_role', rt.payer_role, 'wallet_id', rt.wallet_id);
end $$;

-- ================================================================ state changes
create or replace function lock_request(p_id uuid) returns requests
language plpgsql security definer set search_path = public as $$
declare r requests%rowtype;
begin
  select * into r from requests where id = p_id for update;
  if not found then raise exception using message = 'ไม่พบใบเบิก'; end if;
  return r;
end $$;

create or replace function status_th(s text) returns text
language sql immutable as $$
  select case s when 'to_approve' then 'รออนุมัติ' when 'to_pay' then 'รอจ่าย' when 'paid' then 'จ่ายแล้ว รอตรวจ'
                when 'asked' then 'มีคำถาม' when 'audited' then 'ตรวจแล้ว' when 'rejected' then 'ไม่อนุมัติ' else s end
$$;

create or replace function approve_request(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me role_t := require_role('finance', 'finance_field'); r requests;
begin
  r := lock_request(p_id);
  if r.status <> 'to_approve' then raise exception using message = format('ใบเบิก R%s สถานะ "%s" แล้ว', r.no, status_th(r.status)); end if;
  if me <> 'ceo' and me <> r.approver_role then raise exception using message = 'ใบเบิกนี้ไม่ได้อยู่ในวงเงินที่คุณอนุมัติได้'; end if;
  update requests set status = 'to_pay', approved_by = auth.uid(), approved_at = now() where id = p_id;
  insert into request_events (request_id, action, actor_id) values (p_id, 'approve', auth.uid());
  return jsonb_build_object('id', p_id, 'status', 'to_pay');
end $$;

create or replace function reject_request(p_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me role_t := require_role('finance', 'finance_field'); r requests;
begin
  r := lock_request(p_id);
  if r.status <> 'to_approve' then raise exception using message = format('ใบเบิก R%s สถานะ "%s" แล้ว', r.no, status_th(r.status)); end if;
  if me <> 'ceo' and me <> r.approver_role then raise exception using message = 'ใบเบิกนี้ไม่ได้อยู่ในวงเงินที่คุณอนุมัติได้'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception using message = 'ใส่เหตุผลที่ไม่อนุมัติ'; end if;
  update requests set status = 'rejected', reject_note = btrim(p_note) where id = p_id;
  update request_lines set active = false where request_id = p_id;  -- workers can be claimed again that day
  insert into request_events (request_id, action, actor_id, note) values (p_id, 'reject', auth.uid(), btrim(p_note));
  return jsonb_build_object('id', p_id, 'status', 'rejected');
end $$;

-- pay (from to_pay), or approve-and-pay in one step when the caller is both approver and payer (กวาง on A3 routes)
create or replace function pay_request(p_id uuid, p_proof_paths text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me role_t := require_role('finance', 'finance_field');
  r requests; bal numeric; wname text; l request_lines%rowtype; p text; cat text;
begin
  r := lock_request(p_id);
  if r.status = 'to_approve' then
    if not (me = 'ceo' or (me = r.approver_role and me = r.payer_role)) then
      raise exception using message = format('ใบเบิก R%s ยังไม่ได้อนุมัติ', r.no);
    end if;
  elsif r.status <> 'to_pay' then
    raise exception using message = format('ใบเบิก R%s สถานะ "%s" แล้ว', r.no, status_th(r.status));
  end if;
  if me <> 'ceo' and me <> r.payer_role then raise exception using message = 'ใบเบิกนี้ไม่ได้ให้คุณเป็นคนจ่าย'; end if;
  if coalesce(array_length(array_remove(p_proof_paths, ''), 1), 0) = 0 then
    raise exception using message = case when r.wallet_id = 'A3' then 'แนบสลิปโอนก่อน' else 'ถ่ายรูปผู้รับเงิน/สลิปก่อนกดจ่าย' end;
  end if;

  select name into wname from wallets where id = r.wallet_id for update;  -- serialise payments from the same wallet
  bal := wallet_balance(r.wallet_id);
  if bal < r.total then
    raise exception using message = format('%sไม่พอ (เหลือ %s บาท ต้องจ่าย %s บาท)%s', wname, baht(bal), baht(r.total),
      case when r.wallet_id = 'PC' then ' — ขอเติมเงินสำรองก่อน' else '' end);
  end if;

  for l in select * from request_lines where request_id = p_id and active order by id loop
    cat := case r.type when 'daily_labor' then case when l.worker_id is not null then 'labor' else 'material' end
                       when 'material' then 'material' when 'common' then 'common'
                       when 'salary' then 'salary' when 'petty_refill' then 'petty_refill' end;
    insert into ledger_entries (on_date, wallet_id, amount, category, project_id, ref_table, ref_id, description, created_by)
    values (today_th(), r.wallet_id, -l.amount, cat, l.project_id, 'requests', p_id,
            format('R%s %s%s', r.no, l.description, case when l.room_code is not null then ' · ห้อง ' || l.room_code else '' end), auth.uid());
  end loop;
  if r.type = 'petty_refill' then
    insert into ledger_entries (on_date, wallet_id, amount, category, project_id, ref_table, ref_id, description, created_by)
    values (today_th(), 'PC', r.total, 'petty_refill', 'SH', 'requests', p_id, format('R%s รับเติมเงินสำรองจากบัญชี3', r.no), auth.uid());
  end if;

  foreach p in array array_remove(p_proof_paths, '') loop
    insert into attachments (owner_table, owner_id, kind, path, created_by) values ('requests', p_id, 'payment_proof', p, auth.uid());
  end loop;
  if r.status = 'to_approve' then
    insert into request_events (request_id, action, actor_id) values (p_id, 'approve', auth.uid());
  end if;
  update requests set status = 'paid', paid_by = auth.uid(), paid_at = now(),
         approved_by = coalesce(approved_by, auth.uid()), approved_at = coalesce(approved_at, now())
   where id = p_id;
  insert into request_events (request_id, action, actor_id) values (p_id, 'pay', auth.uid());
  return jsonb_build_object('id', p_id, 'status', 'paid', 'wallet_balance', bal - r.total);
end $$;

create or replace function audit_request(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r requests;
begin
  perform require_role('finance', 'auditor');
  r := lock_request(p_id);
  if r.status <> 'paid' then raise exception using message = format('ใบเบิก R%s สถานะ "%s" — ตรวจได้เมื่อจ่ายแล้ว', r.no, status_th(r.status)); end if;
  update requests set status = 'audited', audited_by = auth.uid(), audited_at = now() where id = p_id;
  insert into request_events (request_id, action, actor_id) values (p_id, 'audit', auth.uid());
  return jsonb_build_object('id', p_id, 'status', 'audited');
end $$;

create or replace function ask_question(p_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r requests;
begin
  perform require_role('finance', 'auditor');
  r := lock_request(p_id);
  if r.status <> 'paid' then raise exception using message = format('ใบเบิก R%s สถานะ "%s" — ถามได้เมื่อจ่ายแล้วรอตรวจ', r.no, status_th(r.status)); end if;
  if coalesce(btrim(p_text), '') = '' then raise exception using message = 'พิมพ์คำถามก่อน'; end if;
  update requests set status = 'asked', question = btrim(p_text), answer = null, asked_by = auth.uid() where id = p_id;
  insert into request_events (request_id, action, actor_id, note) values (p_id, 'ask', auth.uid(), btrim(p_text));
  return jsonb_build_object('id', p_id, 'status', 'asked');
end $$;

create or replace function answer_question(p_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r requests;
begin
  if my_role() is null then raise exception using message = 'กรุณาเข้าสู่ระบบก่อน'; end if;
  r := lock_request(p_id);
  if r.status <> 'asked' then raise exception using message = 'ใบเบิกนี้ไม่มีคำถามรอตอบ'; end if;
  if r.requester_id <> auth.uid() and my_role() <> 'ceo' then raise exception using message = 'ตอบได้เฉพาะคนขอเบิก'; end if;
  if coalesce(btrim(p_text), '') = '' then raise exception using message = 'พิมพ์คำตอบก่อน'; end if;
  update requests set status = 'paid', answer = btrim(p_text) where id = p_id;
  insert into request_events (request_id, action, actor_id, note) values (p_id, 'answer', auth.uid(), btrim(p_text));
  return jsonb_build_object('id', p_id, 'status', 'paid');
end $$;

-- ================================================================ wallets & owner money (SPEC §4.7, §4.10)
create or replace function transfer(p_from text, p_to text, p_amount numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare bal numeric; fname text; tname text; ref uuid := gen_random_uuid();
begin
  perform require_role('finance');
  if p_from = p_to then raise exception using message = 'เลือกบัญชีต้นทางและปลายทางต่างกัน'; end if;
  if p_from not in ('N', 'P', 'A3', 'PC') or p_to not in ('N', 'P', 'A3', 'PC') then raise exception using message = 'บัญชีไม่ถูกต้อง'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่จำนวนเงิน'; end if;
  -- lock both in a fixed order so two opposite transfers cannot deadlock
  perform 1 from wallets where id in (p_from, p_to) order by id for update;
  select name into fname from wallets where id = p_from;
  select name into tname from wallets where id = p_to;
  bal := wallet_balance(p_from);
  if bal < p_amount then raise exception using message = format('%sไม่พอ (เหลือ %s บาท)', fname, baht(bal)); end if;
  insert into ledger_entries (on_date, wallet_id, amount, category, ref_table, ref_id, description, created_by) values
    (today_th(), p_from, -p_amount, 'transfer', 'transfer', ref, format('โอนไป%s%s', tname, coalesce(' · ' || nullif(btrim(p_note), ''), '')), auth.uid()),
    (today_th(), p_to, p_amount, 'transfer', 'transfer', ref, format('รับโอนจาก%s%s', fname, coalesce(' · ' || nullif(btrim(p_note), ''), '')), auth.uid());
  return jsonb_build_object('ref', ref);
end $$;

create or replace function record_owner_paid(p_building text, p_month text, p_amount numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('finance');
  if p_building not in ('N', 'P') then raise exception using message = 'เลือกอาคาร'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่ยอดบิล'; end if;
  if coalesce(btrim(p_month), '') = '' then raise exception using message = 'ใส่เดือนของบิล'; end if;
  insert into ledger_entries (on_date, wallet_id, amount, category, project_id, description, created_by)
  values (today_th(), 'OWNER_PAID', -p_amount, 'owner_paid_expense', p_building,
          format('ค่าไฟ กฟภ. %s %s (เจ้าของจ่ายแทน)%s', (select name from buildings where id = p_building), btrim(p_month),
                 coalesce(' · ' || nullif(btrim(p_note), ''), '')), auth.uid());
end $$;

create or replace function owner_draw_available() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cash numeric; dep numeric; reserve numeric; pend numeric; a3 numeric;
begin
  if my_role() not in ('ceo', 'finance', 'auditor') then raise exception using message = 'คุณไม่มีสิทธิ์ดูยอดนี้'; end if;
  select coalesce(sum(amount), 0) into cash from ledger_entries where wallet_id in ('N', 'P', 'A3');
  select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) into dep from deposits;
  reserve := coalesce((select (value->>'amount')::numeric from settings where key = 'repair_reserve'), 50000);
  select coalesce(sum(total), 0) into pend from requests where wallet_id = 'A3' and status in ('to_approve', 'to_pay');
  a3 := wallet_balance('A3');
  return jsonb_build_object('cash', cash, 'deposits', dep, 'reserve', reserve, 'pending_a3', pend,
                            'available', cash - dep - reserve - pend, 'a3', a3);
end $$;

create or replace function owner_draw(p_amount numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb; avail numeric; a3 numeric;
begin
  perform require_role('finance');
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่จำนวนเงิน'; end if;
  perform 1 from wallets where id in ('A3', 'N', 'P') order by id for update;
  a := owner_draw_available();
  avail := (a->>'available')::numeric; a3 := (a->>'a3')::numeric;
  if avail <= 0 then
    raise exception using message = format('ยังโอนให้เจ้าของไม่ได้ — โอนได้ %s บาท (เงิน 3 บัญชี %s − เงินประกัน %s − สำรองซ่อม %s − รอจ่ายจากบัญชี3 %s)',
      baht(avail), baht((a->>'cash')::numeric), baht((a->>'deposits')::numeric), baht((a->>'reserve')::numeric), baht((a->>'pending_a3')::numeric));
  end if;
  if p_amount > avail then
    raise exception using message = format('เกินยอดที่โอนได้ — โอนได้ไม่เกิน %s บาท (เงิน 3 บัญชี %s − เงินประกัน %s − สำรองซ่อม %s − รอจ่ายจากบัญชี3 %s)',
      baht(avail), baht((a->>'cash')::numeric), baht((a->>'deposits')::numeric), baht((a->>'reserve')::numeric), baht((a->>'pending_a3')::numeric));
  end if;
  if p_amount > a3 then
    raise exception using message = format('บัญชี3 มี %s บาท — โอนจากบัญชีอาคารเข้าบัญชี3 ก่อน', baht(a3));
  end if;
  insert into ledger_entries (on_date, wallet_id, amount, category, description, created_by)
  values (today_th(), 'A3', -p_amount, 'owner_draw', 'โอนให้เจ้าของ' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), auth.uid());
  return jsonb_build_object('available_after', avail - p_amount);
end $$;

create or replace function owner_injection(p_wallet text, p_amount numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('finance');
  if p_wallet not in ('N', 'P', 'A3', 'PC') then raise exception using message = 'บัญชีไม่ถูกต้อง'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่จำนวนเงิน'; end if;
  insert into ledger_entries (on_date, wallet_id, amount, category, description, created_by)
  values (today_th(), p_wallet, p_amount, 'owner_injection', 'เจ้าของเติมเงิน' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), auth.uid());
end $$;

create or replace function record_bank_check(p_wallet text, p_balance numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sys numeric;
begin
  perform require_role('finance');
  if p_wallet not in ('N', 'P', 'A3') then raise exception using message = 'กระทบยอดได้เฉพาะบัญชีธนาคาร (นารา ปรายดาว บัญชี3)'; end if;
  if p_balance is null then raise exception using message = 'ใส่ยอดในแอปธนาคาร'; end if;
  perform 1 from wallets where id = p_wallet for update;
  sys := wallet_balance(p_wallet);
  insert into bank_checks (wallet_id, bank_balance, checked_by) values (p_wallet, p_balance, auth.uid());
  return jsonb_build_object('system', sys, 'bank', p_balance, 'diff', p_balance - sys);
end $$;

-- ================================================================ views
create or replace function request_flags(p_id uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare r requests%rowtype; f text[] := '{}'; att_on boolean;
begin
  select * into r from requests where id = p_id;
  if not found then return f; end if;
  att_on := coalesce((select (value->>'on')::boolean from settings where key = 'attendance_required'), false);
  if r.status in ('paid', 'asked', 'audited')
     and not exists (select 1 from attachments where owner_table = 'requests' and owner_id = p_id and kind = 'payment_proof') then
    f := array_append(f, 'no_payment_proof');
  end if;
  if r.type = 'daily_labor' and not exists (select 1 from attachments where owner_table = 'requests' and owner_id = p_id and kind = 'work') then
    f := array_append(f, 'no_work_photo');
  end if;
  if r.type = 'common' and ((select count(*) from request_lines where request_id = p_id) < 2
       and (select count(*) from attachments where owner_table = 'requests' and owner_id = p_id and kind = 'receipt') < 1
       or exists (select 1 from request_lines where request_id = p_id and description ~ 'ไม่ระบุ')) then
    f := array_append(f, 'common_not_itemised');
  end if;
  if exists (select 1 from request_lines l join projects p on p.id = l.project_id where l.request_id = p_id and p.kind = 'real_estate') then
    f := array_append(f, 'real_estate_loan');
  end if;
  if exists (select 1 from request_lines where request_id = p_id and work_type = 'renovation' and room_code is null) then
    f := array_append(f, 'renovation_no_room');
  end if;
  if att_on and exists (select 1 from request_lines l where l.request_id = p_id and l.worker_id is not null
                          and not exists (select 1 from attendance a where a.worker_id = l.worker_id and a.work_date = l.work_date)) then
    f := array_append(f, 'no_checkin');
  end if;
  if att_on and exists (select 1 from request_lines l join attendance a on a.worker_id = l.worker_id and a.work_date = l.work_date
                         where l.request_id = p_id and (a.lat is null or a.distance_m > 300)) then
    f := array_append(f, 'checkin_far');
  end if;
  return f;
end $$;

create view v_requests with (security_invoker) as
  select r.*, request_flags(r.id) as flags,
         rq.display_name as requester_name, ap.display_name as approver_name,
         pa.display_name as payer_name, au.display_name as auditor_name, ak.display_name as asker_name
    from requests r
    left join profiles rq on rq.id = r.requester_id
    left join profiles ap on ap.id = r.approved_by
    left join profiles pa on pa.id = r.paid_by
    left join profiles au on au.id = r.audited_by
    left join profiles ak on ak.id = r.asked_by;

-- "บัญชีระหว่างเจ้าของกับหอ" = real-estate spending − owner-paid expenses − owner injections (+ opening figures)
create view v_owner_account with (security_invoker) as
  with o as (select coalesce(value, '{}'::jsonb) v from settings where key = 'owner_opening'),
       n as (select
               coalesce(sum(-l.amount) filter (where p.kind = 'real_estate' and l.amount < 0), 0) re_new,
               coalesce(sum(-l.amount) filter (where l.category = 'owner_paid_expense'), 0) owner_paid_new,
               coalesce(sum(l.amount) filter (where l.category = 'owner_injection'), 0) injection_new,
               coalesce(sum(-l.amount) filter (where l.category = 'owner_draw'), 0) draws_new
             from ledger_entries l left join projects p on p.id = l.project_id)
  select coalesce((o.v->>'real_estate')::numeric, 0) re_opening, n.re_new,
         coalesce((o.v->>'owner_paid')::numeric, 0) owner_paid_opening, n.owner_paid_new,
         coalesce((o.v->>'injection')::numeric, 0) injection_opening, n.injection_new,
         n.draws_new,
         coalesce((o.v->>'real_estate')::numeric, 0) + n.re_new
           - coalesce((o.v->>'owner_paid')::numeric, 0) - n.owner_paid_new
           - coalesce((o.v->>'injection')::numeric, 0) - n.injection_new as owner_owes_dorm
    from n left join o on true;

-- latest bank check per wallet vs the ledger balance at that moment
create view v_bank_reconciliation with (security_invoker) as
  select distinct on (b.wallet_id) b.wallet_id, b.bank_balance, b.checked_at, b.checked_by,
         (select coalesce(sum(amount), 0) from ledger_entries l where l.wallet_id = b.wallet_id and l.created_at <= b.checked_at) as system_balance
    from bank_checks b order by b.wallet_id, b.checked_at desc;

grant select on v_requests, v_owner_account, v_bank_reconciliation to authenticated;

-- ================================================================ alerts for M2 (SPEC §4.9)
create or replace function get_alerts_money()
returns table (level text, kind text, title text, detail text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare rec record; pc numeric; low numeric;
begin
  if my_role() is null or my_role() = 'worker' then return; end if;

  -- CEO-level account changes not yet acknowledged (CEO + auditor)
  if my_role() in ('ceo', 'auditor') then
    select count(*) n, string_agg(format('%s %s (%s) โดย %s',
             case s.kind when 'ceo_created' then 'สร้างบัญชี CEO' when 'ceo_granted' then 'ให้สิทธิ์ CEO'
                         when 'ceo_revoked' then 'ถอดสิทธิ์ CEO' when 'ceo_disabled' then 'ปิดบัญชี CEO' else 'เปิดบัญชี CEO' end,
             s.display_name, s.phone, coalesce(s.actor_name, 'ผู้ดูแลระบบ')), ' · ' order by s.at) d
      into rec from security_events s where s.acknowledged_at is null;
    if rec.n > 0 then
      level := 'high'; kind := 'ceo_account';
      title := format('มีการเปลี่ยนบัญชีระดับ CEO %s รายการ — อาร์ตตรวจและกดรับทราบ', rec.n);
      detail := rec.d; amount := null; return next;
    end if;
  end if;

  -- requests with flags, not audited
  select count(*) n, string_agg('R' || r.no, ', ' order by r.no) d into rec
    from requests r where r.status not in ('audited', 'rejected') and cardinality(request_flags(r.id)) > 0;
  if rec.n > 0 then
    level := 'high'; kind := 'request_flags';
    title := format('ใบเบิกมีธง %s รายการ ยังไม่ได้ตรวจ', rec.n); detail := rec.d; amount := null; return next;
  end if;

  -- waiting for approval > 2 days
  select count(*) n, string_agg(format('R%s (%s บาท)', r.no, baht(r.total)), ', ' order by r.no) d, sum(r.total) s into rec
    from requests r where r.status = 'to_approve' and r.created_at < now() - interval '2 days';
  if rec.n > 0 then
    level := 'mid'; kind := 'approval_late';
    title := format('ใบเบิกรออนุมัติเกิน 2 วัน %s รายการ', rec.n); detail := rec.d; amount := rec.s; return next;
  end if;

  if my_role() in ('ceo', 'finance', 'auditor', 'finance_field') then
    -- petty cash low (only once its opening balance exists)
    if exists (select 1 from ledger_entries where wallet_id = 'PC') then
      pc := wallet_balance('PC');
      low := coalesce((select (value->>'amount')::numeric from settings where key = 'petty_cash_low'), 3000);
      if pc < low then
        level := 'mid'; kind := 'petty_cash_low';
        title := format('เงินสำรองนุ้ยเหลือ %s บาท', baht(pc)); detail := 'ควรขอเติมก่อนจ่ายค่าแรงรอบถัดไป'; amount := pc; return next;
      end if;
    end if;
  end if;

  if my_role() in ('ceo', 'finance', 'auditor') then
    -- bank reconciliation mismatch (latest check per wallet)
    for rec in select v.wallet_id, w.name, v.bank_balance, v.system_balance, v.checked_at
                 from v_bank_reconciliation v join wallets w on w.id = v.wallet_id
                where abs(v.bank_balance - v.system_balance) > 0.005 loop
      level := 'high'; kind := 'bank_mismatch';
      title := format('%s ไม่ตรงกับธนาคาร ต่าง %s บาท', rec.name, baht(rec.bank_balance - rec.system_balance));
      detail := format('ธนาคาร %s · ระบบ %s · กระทบยอดเมื่อ %s', baht(rec.bank_balance), baht(rec.system_balance),
                       to_char(rec.checked_at at time zone 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI'));
      amount := rec.bank_balance - rec.system_balance; return next;
    end loop;
  end if;
end $$;

create or replace view v_alerts as select * from get_alerts() union all select * from get_alerts_money();

-- ================================================================ grants & realtime
grant execute on function baht(numeric), ack_security_event(bigint), worker_missing(workers), workers_complete(), upsert_worker(jsonb),
  route_request(text, numeric), wallet_balance(text), salary_status(uuid), set_salary_plan(uuid, numeric),
  submit_request(jsonb), approve_request(uuid), reject_request(uuid, text), pay_request(uuid, text[]),
  audit_request(uuid), ask_question(uuid, text), answer_question(uuid, text), transfer(text, text, numeric, text),
  record_owner_paid(text, text, numeric, text), owner_draw_available(), owner_draw(numeric, text),
  owner_injection(text, numeric, text), record_bank_check(text, numeric), request_flags(uuid), status_th(text),
  get_alerts_money()
  to authenticated;

alter publication supabase_realtime add table request_lines, attachments, bank_checks, security_events, salary_plans;
