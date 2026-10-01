-- M5: reports (SPEC §9 M5). Monthly NOI per building split into rent / electricity margin / water margin, the same
-- cash-basis method as reference/NOI-dashboard.html:
--   revenue  = money actually received for rooms (rent_receipt) — arrears and penalties included
--   elec / water billed = what the round's bills charged (rounds by issue month), utility cost = PEA / waterworks bills
--   electricity margin = elec billed − PEA cost · water margin = water billed − waterworks cost
--   rent profit = revenue − elec billed − water billed − operating costs (labour, material, common, salary)
--   shared costs (project SH / no project) split by room count (setting shared_split, dashboard used นารา 32 : ปรายดาว 38)
--   capex projects (e.g. ห้อง 503) and deposits (a liability) are shown apart, not in NOI; real-estate spending is not
--   a dorm cost. Jan–Sep 2026 come from the owner's dashboard (noi_history, loaded by scripts/import-opening.ts).

-- ---------------------------------------------------------------- utility bills are tagged so the margins can be computed
alter table request_lines add column if not exists utility text check (utility in ('water', 'elec'));
alter table ledger_entries drop constraint if exists ledger_entries_category_check;
alter table ledger_entries add constraint ledger_entries_category_check check (category in (
  'rent_receipt','labor','material','common','salary','transfer','owner_draw','owner_injection',
  'owner_paid_expense','deposit','deposit_refund','petty_refill','staff_room','welfare_housing',
  'opening_balance','adjustment','water_utility','elec_utility'));

insert into settings (key, value) values ('shared_split', '{"N": 32, "P": 38}') on conflict (key) do nothing;

create or replace function update_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('finance');
  if p_key not in ('rates', 'repair_reserve', 'privacy_notice_version', 'site_radius_m', 'shared_split') then
    raise exception using message = format('ไม่รู้จักค่าตั้ง %s', p_key);
  end if;
  if p_key = 'shared_split' and (coalesce((p_value->>'N')::numeric, 0) <= 0 or coalesce((p_value->>'P')::numeric, 0) <= 0) then
    raise exception using message = 'สัดส่วนแบ่งค่าใช้จ่ายร่วมต้องมากกว่า 0 ทั้งสองอาคาร';
  end if;
  insert into settings (key, value, updated_by, updated_at) values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
end $$;

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
    if nullif(ln->>'utility', '') is not null and (v_type <> 'common' or ln->>'utility' not in ('water', 'elec')) then
      raise exception using message = format('รายการที่ %s: ค่าน้ำประปา/ค่าไฟ กฟภ. เลือกได้เฉพาะค่าใช้จ่ายส่วนกลาง', n_lines);
    end if;
    if ln->>'utility' in ('water', 'elec') and coalesce(nullif(ln->>'project_id', ''), 'SH') not in ('N', 'P') then
      raise exception using message = format('รายการที่ %s: บิลค่าน้ำ/ค่าไฟ ต้องเลือกอาคาร (นารา หรือ ปรายดาว)', n_lines);
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
      insert into request_lines (request_id, worker_id, description, amount, project_id, work_type, room_code, work_date, utility)
      values (rid, w.id,
              coalesce(nullif(btrim(ln->>'description'), ''), w.full_name,
                       case v_type when 'salary' then format('เบิกเงินเดือน %s/%s (%s)', to_char(today_th(), 'MM'), extract(year from today_th())::int + 543, (select display_name from profiles where id = v_for))
                                   when 'petty_refill' then 'ขอเติมเงินสำรองนุ้ย' end),
              coalesce(jnum(ln, 'amount'), w.daily_rate),
              coalesce(nullif(ln->>'project_id', ''), 'SH'), v_wt, v_room,
              case when w.id is not null then v_ldate end, nullif(ln->>'utility', ''));
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
                       when 'material' then 'material'
                       when 'common' then case l.utility when 'water' then 'water_utility' when 'elec' then 'elec_utility' else 'common' end
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

-- ---------------------------------------------------------------- Jan–Sep 2026 from the owner's dashboard (read-only)
create table if not exists noi_history (
  month text not null,                 -- 'YYYY-MM'
  building_id text not null references buildings,
  revenue numeric(12,2) not null,
  cost numeric(12,2) not null,
  elec_margin numeric(12,2) not null,
  water_margin numeric(12,2) not null,
  capex numeric(12,2) not null default 0,
  deposits_net numeric(12,2) not null default 0,
  primary key (month, building_id)
);
alter table noi_history enable row level security;
grant select on noi_history to authenticated;
create policy money_read on noi_history for select to authenticated using (my_role() in ('ceo', 'finance', 'auditor'));
create trigger noi_history_no_change before update or delete on noi_history for each row execute function forbid_change();

-- ---------------------------------------------------------------- the report
create or replace function noi_monthly(p_from text, p_to text)
returns table (month text, building_id text, source text, revenue numeric, elec_billed numeric, water_billed numeric,
               elec_cost numeric, water_cost numeric, op_cost numeric, rent_profit numeric, elec_margin numeric,
               water_margin numeric, noi numeric, capex numeric, deposits_net numeric)
language plpgsql stable security definer set search_path = public as $$
declare sn numeric; sp numeric;
begin
  perform require_role('finance', 'auditor');
  if p_from !~ '^\d{4}-\d{2}$' or p_to !~ '^\d{4}-\d{2}$' then raise exception using message = 'เดือนไม่ถูกต้อง (YYYY-MM)'; end if;
  select (value->>'N')::numeric, (value->>'P')::numeric into sn, sp from settings where key = 'shared_split';
  sn := coalesce(sn, 1); sp := coalesce(sp, 1);

  return query
  with months as (
    select to_char(d, 'YYYY-MM') m from generate_series((p_from || '-01')::date, (p_to || '-01')::date, interval '1 month') d
  ), bld as (select unnest(array['N', 'P']) b),
  share as (select 'N'::text b, sn / (sn + sp) f union all select 'P', sp / (sn + sp)),
  le as (   -- each ledger row assigned to one or both buildings
    select to_char(l.on_date, 'YYYY-MM') m, l.category, coalesce(pj.kind, 'shared') kind,
           s.b, l.amount * case when pj.building_id is null then s.f else 1 end amt, l.wallet_id
      from ledger_entries l
      left join projects pj on pj.id = l.project_id
      join share s on s.b = coalesce(pj.building_id, s.b)
     where l.on_date >= (p_from || '-01')::date and l.on_date < ((p_to || '-01')::date + interval '1 month')
       and l.category in ('rent_receipt', 'labor', 'material', 'common', 'salary', 'owner_paid_expense', 'elec_utility', 'water_utility')
       and coalesce(pj.kind, 'shared') <> 'real_estate'
  ), led as (
    select le.m, le.b,
           sum(amt) filter (where category = 'rent_receipt') rev,
           -sum(amt) filter (where category in ('owner_paid_expense', 'elec_utility')) ec,
           -sum(amt) filter (where category = 'water_utility') wc,
           -sum(amt) filter (where category in ('labor', 'material', 'common', 'salary') and kind in ('dorm', 'shared')) op,
           -sum(amt) filter (where category in ('labor', 'material', 'common', 'salary') and kind = 'capex') cx
      from le group by le.m, le.b
  ), dep as (
    select to_char(l.on_date, 'YYYY-MM') m, w.building_id b, sum(l.amount) d
      from ledger_entries l join wallets w on w.id = l.wallet_id
     where l.category in ('deposit', 'deposit_refund') and w.building_id is not null
       and l.on_date >= (p_from || '-01')::date and l.on_date < ((p_to || '-01')::date + interval '1 month')
     group by 1, 2
  ), billed as (
    select to_char(coalesce(rd.issue_date, rd.due_date), 'YYYY-MM') m, ro.building_id b,
           sum(bl.elec_amount) e, sum(bl.water_amount) w
      from bills bl join bill_rounds rd on rd.id = bl.round_id join rooms ro on ro.id = bl.room_id
     where rd.status <> 'draft' and bl.status not in ('vacant', 'welfare')
     group by 1, 2
  ), live as (
    select mo.m, bd.b,
           round(coalesce(led.rev, 0), 2) rev, coalesce(billed.e, 0) e, coalesce(billed.w, 0) w,
           round(coalesce(led.ec, 0), 2) ec, round(coalesce(led.wc, 0), 2) wc, round(coalesce(led.op, 0), 2) op,
           round(coalesce(led.cx, 0), 2) cx, coalesce(dep.d, 0) d
      from months mo cross join bld bd
      left join led on led.m = mo.m and led.b = bd.b
      left join billed on billed.m = mo.m and billed.b = bd.b
      left join dep on dep.m = mo.m and dep.b = bd.b
  )
  select lv.m, lv.b,
         case when h.month is not null then 'history' else 'ledger' end,
         coalesce(h.revenue, lv.rev),
         case when h.month is null then lv.e end, case when h.month is null then lv.w end,
         case when h.month is null then lv.ec end, case when h.month is null then lv.wc end,
         case when h.month is null then lv.op end,
         coalesce(h.revenue - h.cost - h.elec_margin - h.water_margin, lv.rev - lv.e - lv.w - lv.op),
         coalesce(h.elec_margin, lv.e - lv.ec),
         coalesce(h.water_margin, lv.w - lv.wc),
         coalesce(h.revenue - h.cost, lv.rev - lv.ec - lv.wc - lv.op),
         coalesce(h.capex, lv.cx), coalesce(h.deposits_net, lv.d)
    from live lv left join noi_history h on h.month = lv.m and h.building_id = lv.b
   order by lv.m, lv.b;
end $$;

grant execute on function noi_monthly(text, text) to authenticated;
