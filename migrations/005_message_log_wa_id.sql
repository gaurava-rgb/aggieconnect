-- Add WhatsApp message ID for backfill deduplication
-- Run in Supabase SQL Editor

alter table message_log add column if not exists wa_message_id text;
create index if not exists idx_message_log_wa_id on message_log(wa_message_id) where wa_message_id is not null;
