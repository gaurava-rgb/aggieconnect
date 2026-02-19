-- Run this in Supabase SQL Editor

-- All requests and offers (rides, help, etc.)
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
  created_at timestamptz default now()
);

-- Matches between needs and offers
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  need_id uuid references requests(id) on delete cascade,
  offer_id uuid references requests(id) on delete cascade,
  score float default 1.0,
  notified boolean default false,
  created_at timestamptz default now()
);

-- Log every message the bot sees (for auditing)
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

create index if not exists idx_requests_status on requests(status);
create index if not exists idx_requests_category_date on requests(category, date);
create index if not exists idx_requests_destination on requests(destination);
create index if not exists idx_matches_notified on matches(notified);
create index if not exists idx_message_log_created on message_log(created_at);
create index if not exists idx_message_log_is_request on message_log(is_request);
