-- Run this in Supabase SQL Editor
-- Full schema for Aggie Connect

-- ============================================================
-- Monitored groups (managed via Supabase Table Editor UI)
-- ============================================================
create table if not exists monitored_groups (
  group_id text primary key,
  group_name text,
  active boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-update updated_at on any row change
create or replace function update_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at
  before update on monitored_groups
  for each row execute function update_timestamp();

-- ============================================================
-- Requests and offers (rides, help, etc.)
-- ============================================================
create table if not exists requests (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_group text,
  source_contact text not null,
  type text not null,
  category text not null,
  date date,
  origin text,
  destination text,
  details jsonb default '{}',
  raw_message text,
  status text default 'open',
  request_hash text,
  created_at timestamptz default now()
);

-- ============================================================
-- Matches between needs and offers
-- ============================================================
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  need_id uuid references requests(id) on delete cascade,
  offer_id uuid references requests(id) on delete cascade,
  score float default 1.0,
  notified boolean default false,
  created_at timestamptz default now()
);

-- ============================================================
-- Message log (audit trail for every message the bot sees)
-- ============================================================
create table if not exists message_log (
  id uuid primary key default gen_random_uuid(),
  source_group text,
  source_contact text,
  sender_name text,
  message_text text,
  is_request boolean default false,
  parsed_data jsonb,
  error text,
  created_at timestamptz default now()
);

-- ============================================================
-- Indexes
-- ============================================================
create index if not exists idx_requests_status on requests(request_status);
create index if not exists idx_requests_category_date on requests(request_category, ride_plan_date);
create index if not exists idx_requests_destination on requests(request_destination);
create index if not exists idx_requests_hash on requests(request_hash);
create index if not exists idx_matches_notified on matches(notified);
create index if not exists idx_message_log_created on message_log(created_at);
create index if not exists idx_message_log_is_request on message_log(is_request);
create index if not exists idx_monitored_groups_active on monitored_groups(active);-- ============================================================
-- Migration helper: run these if tables already exist
-- ============================================================
-- alter table requests add column if not exists request_hash text;
-- create index if not exists idx_requests_hash on requests(request_hash);