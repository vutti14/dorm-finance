-- Other income / other expenses (owner decision 1 ต.ค. 69): เป้อ and นุ้ย record money that is not rent and not a
-- request — e.g. laundry, water vending machine, key cards, bank interest, or any new kind they add themselves.
-- Kinds are a list anyone on the field team can extend ("ไม่ล็อกตาย"). Entries go to the ledger (append-only; a mistake
-- is reversed with a reason, never edited) and count in NOI: other income in revenue, other expenses in operating cost.

create table money_kinds (
  id serial primary key,
  direction text not null check (direction in ('income', 'expense')),
  name text not null,
  active boolean not null default true,
  created_by uuid references profiles,
  created_at timestamptz not null default now()
);
create unique index money_kinds_name on money_kinds (direction, lower(btrim(name)));
alter table money_kinds enable row level security;
grant select on money_kinds to authenticated;
create policy staff_read on money_kinds for select to authenticated using (is_staff());
create trigger audit_money_kinds after insert or update or delete on money_kinds for each row execute function audit_trigger();
insert into money_kinds (direction, name) values
  ('income', 'ซักผ้า'), ('income', 'ตู้น้ำ'), ('income', 'keycard'), ('income', 'ดอกเบี้ย');

alter table ledger_entries
  add column if not exists kind_id int references money_kinds,
  add column if not exists photo_path text,
  add column if not exists reverses bigint unique references ledger_entries;
alter table ledger_entries drop constraint if exists ledger_entries_category_check;
alter table ledger_entries add constraint ledger_entries_category_check check (category in (
  'rent_receipt','labor','material','common','salary','transfer','owner_draw','owner_injection',
  'owner_paid_expense','deposit','deposit_refund','petty_refill','staff_room','welfare_housing',
  'opening_balance','adjustment','water_utility','elec_utility','other_income','other_expense'));

create or replace function add_money_kind(p_direction text, p_name text) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int; v_name text := btrim(coalesce(p_name, ''));
begin
  perform require_role('manager', 'finance_field', 'finance');
  if p_direction not in ('income', 'expense') then raise exception using message = 'เลือก รายได้ หรือ รายจ่าย'; end if;
  if length(v_name) < 2 then raise exception using message = 'ใส่ชื่อประเภท'; end if;
  select id into v_id from money_kinds where direction = p_direction and lower(btrim(name)) = lower(v_name);
  if found then
    update money_kinds set active = true where id = v_id and not active;
    return v_id;
  end if;
  insert into money_kinds (direction, name, created_by) values (p_direction, v_name, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function record_other_money(p_direction text, p_kind int, p_wallet text, p_project text, p_amount numeric,
                                              p_on_date date default null, p_note text default null, p_photo_path text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare k money_kinds%rowtype; pj projects%rowtype; v_date date := coalesce(p_on_date, today_th()); bal numeric; wname text; v_id bigint;
begin
  perform require_role('manager', 'finance_field');
  select * into k from money_kinds where id = p_kind;
  if not found or not k.active then raise exception using message = 'เลือกประเภท'; end if;
  if k.direction <> p_direction then raise exception using message = 'ประเภทนี้ไม่ใช่' || case p_direction when 'income' then 'รายได้' else 'รายจ่าย' end; end if;
  if p_wallet not in ('N', 'P', 'A3', 'PC') then raise exception using message = 'เลือกบัญชีที่เงินเข้า/ออก'; end if;
  select * into pj from projects where id = p_project;
  if not found or not pj.active or pj.kind not in ('dorm', 'shared') then
    raise exception using message = 'เลือกอาคาร (นารา / ปรายดาว / ส่วนกลาง) — งานโครงการ/งบลงทุนให้ใช้ใบเบิก';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception using message = 'ใส่จำนวนเงิน'; end if;
  if v_date > today_th() then raise exception using message = 'วันที่ต้องไม่เกินวันนี้'; end if;
  if p_direction = 'expense' and coalesce(btrim(p_photo_path), '') = '' then
    raise exception using message = 'รายจ่ายต้องถ่ายรูปใบเสร็จ/สลิป';
  end if;
  if p_direction = 'expense' then
    select name into wname from wallets where id = p_wallet for update;   -- serialise with other payments
    bal := wallet_balance(p_wallet);
    if bal < p_amount then
      raise exception using message = format('%sไม่พอ (เหลือ %s บาท)', wname, baht(bal));
    end if;
  end if;
  insert into ledger_entries (on_date, wallet_id, amount, category, project_id, kind_id, photo_path, description, created_by)
  values (v_date, p_wallet, case p_direction when 'income' then p_amount else -p_amount end,
          case p_direction when 'income' then 'other_income' else 'other_expense' end, p_project, k.id, nullif(btrim(p_photo_path), ''),
          k.name || coalesce(' · ' || nullif(btrim(p_note), ''), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function reverse_other_money(p_id bigint, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare l ledger_entries%rowtype; v_id bigint;
begin
  perform require_role('manager', 'finance_field', 'finance');
  if coalesce(btrim(p_reason), '') = '' then raise exception using message = 'ใส่เหตุผลที่กลับรายการ'; end if;
  select * into l from ledger_entries where id = p_id for update;
  if not found or l.category not in ('other_income', 'other_expense') or l.reverses is not null then
    raise exception using message = 'กลับรายการได้เฉพาะรายได้อื่น/รายจ่ายอื่น';
  end if;
  if exists (select 1 from ledger_entries where reverses = p_id) then raise exception using message = 'รายการนี้กลับไปแล้ว'; end if;
  insert into ledger_entries (on_date, wallet_id, amount, category, project_id, kind_id, reverses, description, created_by)
  values (today_th(), l.wallet_id, -l.amount, l.category, l.project_id, l.kind_id, l.id,
          format('กลับรายการ #%s %s · %s', l.id, l.description, btrim(p_reason)), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- NOI now includes other income / other expenses
drop function noi_monthly(text, text);
create or replace function noi_monthly(p_from text, p_to text)
returns table (month text, building_id text, source text, revenue numeric, other_income numeric, elec_billed numeric, water_billed numeric,
               elec_cost numeric, water_cost numeric, op_cost numeric, other_expense numeric, rent_profit numeric, elec_margin numeric,
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
       and l.category in ('rent_receipt', 'labor', 'material', 'common', 'salary', 'owner_paid_expense', 'elec_utility', 'water_utility',
                          'other_income', 'other_expense')
       and coalesce(pj.kind, 'shared') <> 'real_estate'
  ), led as (
    select le.m, le.b,
           sum(amt) filter (where category = 'rent_receipt') rev,
           -sum(amt) filter (where category in ('owner_paid_expense', 'elec_utility')) ec,
           -sum(amt) filter (where category = 'water_utility') wc,
           -sum(amt) filter (where category in ('labor', 'material', 'common', 'salary') and kind in ('dorm', 'shared')) op,
           -sum(amt) filter (where category in ('labor', 'material', 'common', 'salary') and kind = 'capex') cx,
           sum(amt) filter (where category = 'other_income') oi,
           -sum(amt) filter (where category = 'other_expense') oe
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
           round(coalesce(led.cx, 0), 2) cx, coalesce(dep.d, 0) d,
           round(coalesce(led.oi, 0), 2) oi, round(coalesce(led.oe, 0), 2) oe
      from months mo cross join bld bd
      left join led on led.m = mo.m and led.b = bd.b
      left join billed on billed.m = mo.m and billed.b = bd.b
      left join dep on dep.m = mo.m and dep.b = bd.b
  )
  select lv.m, lv.b,
         case when h.month is not null then 'history' else 'ledger' end,
         coalesce(h.revenue, lv.rev),
         case when h.month is null then lv.oi end,
         case when h.month is null then lv.e end, case when h.month is null then lv.w end,
         case when h.month is null then lv.ec end, case when h.month is null then lv.wc end,
         case when h.month is null then lv.op end,
         case when h.month is null then lv.oe end,
         coalesce(h.revenue - h.cost - h.elec_margin - h.water_margin, lv.rev + lv.oi - lv.e - lv.w - lv.op - lv.oe),
         coalesce(h.elec_margin, lv.e - lv.ec),
         coalesce(h.water_margin, lv.w - lv.wc),
         coalesce(h.revenue - h.cost, lv.rev + lv.oi - lv.ec - lv.wc - lv.op - lv.oe),
         coalesce(h.capex, lv.cx), coalesce(h.deposits_net, lv.d)
    from live lv left join noi_history h on h.month = lv.m and h.building_id = lv.b
   order by lv.m, lv.b;
end $$;
grant execute on function noi_monthly(text, text), add_money_kind(text, text),
  record_other_money(text, int, text, text, numeric, date, text, text), reverse_other_money(bigint, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table money_kinds;
  end if;
end $$;
