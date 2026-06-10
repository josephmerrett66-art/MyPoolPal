create extension if not exists pgcrypto;

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references companies(id) on delete set null,
  email text,
  full_name text,
  role text not null default 'admin' check (role in ('admin', 'manager', 'technician')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists technicians (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  name text not null,
  pin_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists company_settings (
  company_id uuid primary key references companies(id) on delete cascade,
  response_style text not null default 'Short field answer',
  target_ph text not null default '7.4',
  target_chlorine text not null default '3',
  target_alkalinity text not null default '120',
  max_acid_ml text not null default '2000',
  company_procedures text not null default '',
  vehicle_stock text not null default '',
  company_knowledge text not null default '',
  message_tone text not null default 'Friendly and professional',
  message_greeting text not null default 'Hi [Customer Name],',
  message_signoff text not null default 'Thanks, [Company Name]',
  message_template text not null default 'Keep customer messages clear, calm, and professional. Use simple language. Explain what was found, what was done or recommended, and the next step. Do not blame the customer. Make the message ready to copy into SMS, email, or ServiceM8.',
  updated_at timestamptz not null default now()
);

alter table company_settings add column if not exists message_tone text not null default 'Friendly and professional';
alter table company_settings add column if not exists message_greeting text not null default 'Hi [Customer Name],';
alter table company_settings add column if not exists message_signoff text not null default 'Thanks, [Company Name]';
alter table company_settings add column if not exists message_template text not null default 'Keep customer messages clear, calm, and professional. Use simple language. Explain what was found, what was done or recommended, and the next step. Do not blame the customer. Make the message ready to copy into SMS, email, or ServiceM8.';

create table if not exists company_knowledge (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  equipment_type text,
  equipment_brand text,
  issue_category text,
  knowledge_entry text not null,
  source text not null default 'Technician Improvement',
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists manuals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  file_name text not null,
  brand text,
  model text,
  equipment_type text,
  notes text,
  storage_path text not null,
  uploaded_by uuid references profiles(id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create table if not exists manual_chunks (
  id uuid primary key default gen_random_uuid(),
  manual_id uuid not null references manuals(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  page integer,
  chunk_index integer not null,
  chunk_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists stock_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  chemical_key text not null,
  label text not null,
  unit text not null,
  amount numeric not null default 0,
  cost_per_unit numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (company_id, chemical_key)
);

create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  technician_id uuid references technicians(id) on delete set null,
  conversation_id uuid,
  movement_type text not null check (movement_type in ('recommendation', 'actual_usage', 'topup', 'adjustment')),
  chemical_key text not null,
  amount numeric not null,
  unit text not null,
  cost numeric not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  technician_id uuid references technicians(id) on delete set null,
  title text not null default 'Pool service chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  token_input integer,
  token_output integer,
  created_at timestamptz not null default now()
);

create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  purpose text,
  tone_rules text,
  template_text text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists photo_uploads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  technician_id uuid references technicians(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  file_name text not null,
  storage_path text not null,
  analysis_summary text,
  uploaded_at timestamptz not null default now()
);

alter table companies enable row level security;
alter table profiles enable row level security;
alter table technicians enable row level security;
alter table company_settings enable row level security;
alter table company_knowledge enable row level security;
alter table manuals enable row level security;
alter table manual_chunks enable row level security;
alter table stock_items enable row level security;
alter table stock_movements enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table message_templates enable row level security;
alter table photo_uploads enable row level security;

drop policy if exists companies_select_members on companies;
drop policy if exists companies_insert_owner on companies;
drop policy if exists companies_update_owner on companies;
drop policy if exists profiles_select_company_members on profiles;
drop policy if exists profiles_insert_self on profiles;
drop policy if exists profiles_update_self on profiles;
drop policy if exists company_settings_company_members on company_settings;
drop policy if exists company_knowledge_company_members on company_knowledge;
drop policy if exists manuals_company_members on manuals;
drop policy if exists manual_chunks_company_members on manual_chunks;
drop policy if exists stock_items_company_members on stock_items;
drop policy if exists stock_movements_company_members on stock_movements;

create policy companies_select_members
on companies for select
using (
  owner_user_id = auth.uid()
  or exists (
    select 1 from profiles
    where profiles.company_id = companies.id
    and profiles.id = auth.uid()
  )
);

create policy companies_insert_owner
on companies for insert
with check (owner_user_id = auth.uid());

create policy companies_update_owner
on companies for update
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

create policy profiles_select_company_members
on profiles for select
using (id = auth.uid());

create policy profiles_insert_self
on profiles for insert
with check (id = auth.uid());

create policy profiles_update_self
on profiles for update
using (id = auth.uid())
with check (id = auth.uid());

create policy company_settings_company_members
on company_settings for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = company_settings.company_id
  )
)
with check (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = company_settings.company_id
  )
);

create policy company_knowledge_company_members
on company_knowledge for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = company_knowledge.company_id
  )
)
with check (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = company_knowledge.company_id
  )
);

create policy manuals_company_members
on manuals for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = manuals.company_id
  )
)
with check (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = manuals.company_id
  )
);

create policy manual_chunks_company_members
on manual_chunks for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = manual_chunks.company_id
  )
)
with check (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = manual_chunks.company_id
  )
);

create policy stock_items_company_members
on stock_items for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = stock_items.company_id
  )
)
with check (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = stock_items.company_id
  )
);

create policy stock_movements_company_members
on stock_movements for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = stock_movements.company_id
  )
)
with check (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.company_id = stock_movements.company_id
  )
);
