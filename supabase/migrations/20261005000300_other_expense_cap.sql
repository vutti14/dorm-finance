-- Owner decision 1 ต.ค. 69: other expenses recorded directly (no approval) are capped at 3,000 baht; anything larger
-- goes through a request with an approver. The cap is a setting กวาง/CEO can change in ตั้งค่า.
insert into settings (key, value) values ('other_expense_cap', '{"amount": 3000}') on conflict (key) do nothing;

create or replace function update_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('finance');
  if p_key not in ('rates', 'repair_reserve', 'privacy_notice_version', 'site_radius_m', 'shared_split', 'other_expense_cap') then
    raise exception using message = format('ไม่รู้จักค่าตั้ง %s', p_key);
  end if;
  if p_key = 'shared_split' and (coalesce((p_value->>'N')::numeric, 0) <= 0 or coalesce((p_value->>'P')::numeric, 0) <= 0) then
    raise exception using message = 'สัดส่วนแบ่งค่าใช้จ่ายร่วมต้องมากกว่า 0 ทั้งสองอาคาร';
  end if;
  if p_key = 'other_expense_cap' and coalesce((p_value->>'amount')::numeric, -1) < 0 then
    raise exception using message = 'เพดานรายจ่ายอื่นต้องเป็นตัวเลข 0 ขึ้นไป';
  end if;
  insert into settings (key, value, updated_by, updated_at) values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
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
  if p_direction = 'expense' and p_amount > coalesce((select (value->>'amount')::numeric from settings where key = 'other_expense_cap'), 3000) then
    raise exception using message = format('รายจ่ายเกิน %s บาท ต้องทำใบเบิก (มีผู้อนุมัติ) — ช่องนี้สำหรับรายจ่ายเล็ก ๆ',
      to_char(coalesce((select (value->>'amount')::numeric from settings where key = 'other_expense_cap'), 3000), 'FM999,999,990'));
  end if;
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
