-- Dorm Finance — schema (SPEC §5)
-- Money is numeric(12,2). Time zone Asia/Bangkok. Every table gets RLS in the next migration.

-- gen_random_uuid() is core Postgres (13+); no extension needed.

create type role_t as enum ('ceo','manager','finance_field','finance','auditor','worker');
create type room_status_t as enum ('occupied','vacant','staff','renovation');

-- ---------------------------------------------------------------- people
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null,
  phone text unique not null check (phone ~ '^0[0-9]{9}$'),
  role role_t not null,
  worker_id uuid,
  active boolean not null default true,
  consent_at timestamptz,
  consent_version text,
  created_at timestamptz not null default now()
);

-- one-time activation codes (hash only; the code itself is shown once to the admin)
create table activation_codes (
  id bigint generated always as identity primary key,
  profile_id uuid not null references profiles on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references profiles,
  created_at timestamptz not null default now()
);

create table login_attempts (
  id bigint generated always as identity primary key,
  phone text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_phone_at on login_attempts (phone, at desc);

-- ---------------------------------------------------------------- places & money buckets
create table buildings (
  id text primary key,
  name text not null,
  bill_name text,
  bank_name text,
  bank_account_name text,
  bank_account_no text,
  contact_phone text,
  lat double precision,
  lng double precision
);

create table wallets (
  id text primary key,
  name text not null,
  building_id text references buildings,
  is_virtual boolean not null default false
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles,
  updated_at timestamptz not null default now()
);

create table projects (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('dorm','capex','shared','real_estate')),
  building_id text references buildings,
  active boolean not null default true
);

-- ---------------------------------------------------------------- rooms & tenants
create table rooms (
  id uuid primary key default gen_random_uuid(),
  building_id text not null references buildings,
  code text unique not null,
  status room_status_t not null,
  base_rent numeric(12,2) not null default 0,
  elec_rate_override numeric(8,2),
  water_flat numeric(12,2),
  service_fee numeric(12,2) not null default 0,
  recurring_discount numeric(12,2) not null default 0,
  has_meter boolean not null default true,
  note text,
  -- token for the public tenant-registration link / QR (SPEC §4.6)
  reg_token text unique not null default replace(gen_random_uuid()::text, '-', '')
);

create table tenants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references rooms,
  name text,
  phone text,
  line_id text,
  emergency_name text,
  emergency_phone text,
  move_in date,
  move_out date,
  active boolean not null default true,
  source text not null default 'import' check (source in ('import','registration','manual')),
  created_at timestamptz not null default now()
);
create unique index one_active_tenant_per_room on tenants (room_id) where active;

create table tenant_registrations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms,
  name text not null,
  phone text not null,
  line_id text,
  emergency_name text,
  emergency_phone text,
  notice_version text not null,
  accepted_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references profiles,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create unique index one_pending_registration_per_room on tenant_registrations (room_id) where status = 'pending';

-- ---------------------------------------------------------------- billing
create table bill_rounds (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  meter_month text,
  issue_date date,
  due_date date not null,
  status text not null default 'draft' check (status in ('draft','issued','closed')),
  rates jsonb not null,          -- {elec, water, pen_day, pen_max}
  bill_info jsonb not null default '{}'::jsonb, -- {names:{N,P}, bank:{N:{bank,name,no},P:{...}}, contact}
  created_by uuid references profiles,
  created_at timestamptz not null default now(),
  issued_by uuid references profiles,
  issued_at timestamptz
);

create table meter_readings (
  id uuid primary key default gen_random_uuid(),
  round_id uuid references bill_rounds on delete cascade,
  room_id uuid references rooms,
  kind text check (kind in ('elec','water')),
  prev numeric(12,2),
  curr numeric(12,2),
  prev_units numeric(12,2),      -- units used the month before (for the "over 2x" flag)
  ai_value numeric(12,2),        -- M4: optional AI reading, human confirms
  photo_path text,
  read_by uuid references profiles,
  read_by_name text,
  read_at timestamptz not null default now(),
  unique (round_id, room_id, kind)
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  round_id uuid references bill_rounds on delete cascade,
  room_id uuid references rooms,
  tenant_name text,
  tenant_phone text,
  status text check (status in ('open','closed','vacant','welfare')),
  rent numeric(12,2) not null default 0,
  elec_prev numeric(12,2), elec_curr numeric(12,2),
  elec_units numeric(12,2), elec_rate numeric(8,2), elec_amount numeric(12,2) not null default 0,
  water_prev numeric(12,2), water_curr numeric(12,2),
  water_units numeric(12,2), water_rate numeric(8,2), water_amount numeric(12,2) not null default 0,
  water_is_flat boolean not null default false,
  service numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  penalty numeric(12,2) not null default 0,
  carry_in numeric(12,2) not null default 0,
  items_total numeric(12,2) not null default 0,
  paid numeric(12,2) not null default 0,
  flags text[] not null default '{}',
  total numeric(12,2) generated always as
    (rent + elec_amount + water_amount + service - discount + items_total + penalty + carry_in) stored,
  unique (round_id, room_id)
);

create table bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid references bills on delete cascade,
  description text not null,
  amount numeric(12,2) not null,
  source text not null default 'import' check (source in ('import','adjustment')),
  created_by uuid references profiles,
  reason text,
  created_at timestamptz not null default now()
);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid references bills,
  amount numeric(12,2) check (amount > 0),
  received_on date not null,
  wallet_id text references wallets,
  slip_path text,
  note text,
  recorded_by uuid references profiles,
  created_at timestamptz not null default now()
);

create table deposits (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references rooms,
  tenant_name text,
  kind text check (kind in ('deposit','booking','refund','opening')),
  amount numeric(12,2) check (amount > 0),
  wallet_id text references wallets,
  on_date date,
  recorded_by uuid references profiles,
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- ledger (append-only)
create table ledger_entries (
  id bigint generated always as identity primary key,
  on_date date not null,
  wallet_id text not null references wallets,
  amount numeric(12,2) not null,   -- + in, - out
  category text not null check (category in (
    'rent_receipt','labor','material','common','salary','transfer','owner_draw','owner_injection',
    'owner_paid_expense','deposit','deposit_refund','petty_refill','staff_room','welfare_housing',
    'opening_balance','adjustment')),
  project_id text references projects,
  ref_table text,
  ref_id uuid,
  description text,
  created_by uuid references profiles,
  created_at timestamptz not null default now()
);
create index ledger_wallet on ledger_entries (wallet_id);

-- Jan–Sep 2026 handwritten books, read-only history for the dashboard (SPEC §8.2). Never mixed into ledger_entries.
create table ledger_history (
  id bigint generated always as identity primary key,
  book text not null check (book in ('A3','N','P','RE_ALLOC')),
  on_date date not null,
  description text,
  category text,
  site text,
  amount_in numeric(12,2),
  amount_out numeric(12,2),
  balance numeric(12,2),
  source_row int
);

-- ---------------------------------------------------------------- crew & requests (M2/M3 use these; created now so the schema is whole)
create table workers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  kind text check (kind in ('technician','maid')),
  daily_rate numeric(10,2) not null,
  phone text,
  national_id text,
  id_card_path text,
  is_team_lead boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table profiles add constraint profiles_worker_fk foreign key (worker_id) references workers;

create table attendance (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid references workers,
  work_date date not null,
  checked_at timestamptz not null default now(),
  device_at timestamptz,
  project_id text references projects,
  work_note text,
  selfie_path text,
  lat double precision, lng double precision, accuracy_m int, distance_m int,
  on_behalf_by uuid references profiles,
  by_lead uuid references workers,
  checkout_at timestamptz,
  checkout_note text,
  unique (worker_id, work_date)
);

create table requests (
  id uuid primary key default gen_random_uuid(),
  no serial,
  type text not null check (type in ('daily_labor','material','common','salary','petty_refill')),
  requester_id uuid references profiles,
  work_date date,
  status text not null check (status in ('to_approve','to_pay','paid','asked','audited','rejected')),
  approver_role role_t,
  payer_role role_t,
  wallet_id text references wallets,
  total numeric(12,2) not null,
  question text,
  answer text,
  created_at timestamptz not null default now()
);

create table request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references requests on delete cascade,
  worker_id uuid references workers,
  description text not null,
  amount numeric(12,2) not null,
  project_id text not null references projects,
  work_type text check (work_type in ('routine','renovation','project')),
  room_code text,
  work_date date
);
create unique index one_worker_per_day on request_lines (worker_id, work_date) where worker_id is not null;

create table attachments (
  id uuid primary key default gen_random_uuid(),
  owner_table text,
  owner_id uuid,
  kind text check (kind in ('work','payment_proof','receipt','meter','id_card','selfie','slip')),
  path text not null,
  created_by uuid references profiles,
  created_at timestamptz not null default now()
);

create table request_events (
  id bigint generated always as identity primary key,
  request_id uuid references requests,
  action text,
  actor_id uuid references profiles,
  note text,
  created_at timestamptz not null default now()
);

create table salary_plans (
  profile_id uuid primary key references profiles,
  monthly numeric(12,2)
);

create table bank_checks (
  id bigint generated always as identity primary key,
  wallet_id text references wallets,
  bank_balance numeric(12,2),
  checked_at timestamptz not null default now(),
  checked_by uuid references profiles
);

create table audit_log (
  id bigint generated always as identity primary key,
  table_name text,
  row_id text,
  action text,
  old jsonb,
  new jsonb,
  actor uuid,
  at timestamptz not null default now()
);
