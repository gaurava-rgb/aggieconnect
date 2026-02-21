-- Migration: Add monitored_groups table and request_hash dedup
-- Run this in Supabase SQL Editor

-- 1. Monitored groups table
create table if not exists monitored_groups (
  group_id text primary key,
  group_name text,
  active boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_monitored_groups_active on monitored_groups(active);

-- 2. Auto-update trigger for updated_at
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

-- 3. Add request_hash to requests table for dedup
alter table requests add column if not exists request_hash text;
create index if not exists idx_requests_hash on requests(request_hash);

-- 4. Seed currently monitored groups (from .env TARGET_GROUPS)
insert into monitored_groups (group_id, group_name, active) values
  ('120363228982295252@g.us', 'Texas A & M, College Station community | FALL 2024', true),
  ('120363313702902528@g.us', 'MIS 2026 Squad', true),
  ('120363207175764555@g.us', 'TAMU MS-MIS Class of 2026', true),
  ('120363402862232924@g.us', 'IGSA TAMU Community', true),
  ('120363419472625460@g.us', 'IGSA TAMU | Ride share', true),
  ('120363406458700368@g.us', 'IGSA TAMU | Housing', true),
  ('120363421308938431@g.us', 'IGSA TAMU | Buy/Sell', true),
  ('120363403691419250@g.us', 'IGSA TAMU Community', true),
  ('120363419396294925@g.us', 'IGSA TAMU | General', true),
  ('120363211486900624@g.us', 'Texas A & M, College Station community | FALL 2024', true),
  ('120363423291214850@g.us', 'IGSA TAMU | Sports', true)
on conflict (group_id) do nothing;
