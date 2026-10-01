-- Seed data (SPEC §4.1, §4.2, §4.6 rates, §8.2). No real names / phones / money here: rooms and tenants come from
-- the Excel import; balances and history from scripts/import-opening.ts.

insert into buildings (id, name, bill_name, lat, lng) values
  ('N', 'นารา แมนชั่น', 'นารา แมนชั่น', 16.801452, 100.2576706),
  ('P', 'ปรายดาวรีสอร์ท', 'ปรายดาวรีสอร์ท', 16.8152201, 100.3433006);

insert into wallets (id, name, building_id, is_virtual) values
  ('N', 'บัญชีนารา', 'N', false),
  ('P', 'บัญชีปรายดาว', 'P', false),
  ('A3', 'บัญชี3 (กลาง)', null, false),
  ('PC', 'เงินสำรองนุ้ย', null, false),
  ('OWNER_PAID', 'เจ้าของจ่ายแทน', null, true),
  ('NONCASH', 'รายการไม่ใช่เงินสด (สวัสดิการ)', null, true);

insert into projects (id, name, kind, building_id) values
  ('N', 'หอนารา', 'dorm', 'N'),
  ('P', 'หอปรายดาว', 'dorm', 'P'),
  ('N503', 'ห้อง 503 นารา (งบลงทุน)', 'capex', 'N'),
  ('SH', 'ส่วนกลาง 2 หอ', 'shared', null),
  ('WAL', 'Waldorf', 'real_estate', null),
  ('WIN', 'Winston', 'real_estate', null),
  ('WIS', 'Wisdom Town', 'real_estate', null),
  ('PJ', 'บ้านโครงการ 45/3, 45/4, 168', 'real_estate', null),
  ('BP', 'บึงพระ', 'real_estate', null),
  ('DK', 'ดงข่อย', 'real_estate', null),
  ('ZEN', 'Zen', 'real_estate', null),
  ('H222', 'บ้าน 222 ราษฎร์อุทิศ', 'real_estate', null),
  ('OWN', 'ส่วนตัวเจ้าของ', 'real_estate', null);

insert into settings (key, value) values
  ('rates', '{"elec": 8, "water": 30, "pen_day": 100, "pen_max": 3100}'),
  ('repair_reserve', '{"amount": 50000}'),
  ('privacy_notice_version', '{"version": "1"}'),
  ('site_radius_m', '{"meters": 300}'),
  ('salary_defaults', '{"manager": 17000, "finance_field": 10000}');

-- Wallet opening balances (2026-09-30), the owner-account opening figures and the Jan–Sep history are loaded by
-- scripts/import-opening.ts from /reference (kept out of git). PC is entered by finance at go-live (ตั้งค่า).

-- 5 known workers: nicknames only, registry incomplete on purpose (no ID numbers / ID photos yet)
insert into workers (full_name, kind, daily_rate) values
  ('ช่างเต้', 'technician', 400),
  ('ช่างอ้น', 'technician', 400),
  ('ช่างแม็ค', 'technician', 450),
  ('ช่างเอ', 'technician', 400),
  ('แม่บ้าน (ยังไม่ใส่ชื่อ)', 'maid', 350);

-- private bucket for photos (SPEC §1.7); only exists on Supabase
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict (id) do nothing;
  end if;
end $$;
