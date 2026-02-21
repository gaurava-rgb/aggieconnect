-- Migration: Rename requests table columns for clarity
-- Run this in Supabase SQL Editor

alter table requests rename column type to request_type;
alter table requests rename column category to request_category;
alter table requests rename column date to request_date;
alter table requests rename column origin to request_origin;
alter table requests rename column destination to request_destination;
alter table requests rename column details to request_details;
alter table requests rename column status to request_status;

-- Recreate indexes with new column names
drop index if exists idx_requests_status;
drop index if exists idx_requests_category_date;
drop index if exists idx_requests_destination;

create index idx_requests_status on requests(request_status);
create index idx_requests_category_date on requests(request_category, request_date);
create index idx_requests_destination on requests(request_destination);
