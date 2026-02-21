-- One-time cleanup: deduplicate entries created by manual data export
-- Run in Supabase SQL Editor
--
-- Problem: Manual export created duplicate requests for the same person
-- because one export had a phone number and the other didn't, causing
-- different request_hash values.

-- ============================================================
-- Step 1: Find Sakshi Naik duplicates
-- Her number is +917769933943 / 917769933943
-- One entry has her number, the other doesn't (from text vs image export)
-- ============================================================

-- Preview duplicates (run this first to identify the IDs):
-- select id, source_contact, request_type, request_destination, ride_plan_date, request_status, request_hash
-- from requests
-- where source_contact ilike '%sakshi%' or source_contact ilike '%7769933943%';

-- Delete the entry WITHOUT the phone number (keep the one with it).
-- Replace <UUID_WITHOUT_NUMBER> with the actual ID from the preview query above.
-- delete from matches where need_id = '<UUID_WITHOUT_NUMBER>' or offer_id = '<UUID_WITHOUT_NUMBER>';
-- delete from requests where id = '<UUID_WITHOUT_NUMBER>';

-- Also clean up any self-matches (same person matched with themselves):
delete from matches
where need_id in (select id from requests where source_contact ilike '%7769933943%')
  and offer_id in (select id from requests where source_contact ilike '%7769933943%');

-- ============================================================
-- Step 2: Find Shaunak duplicates (number ending 4443)
-- ============================================================

-- Preview duplicates:
-- select id, source_contact, request_type, request_destination, ride_plan_date, request_status, request_hash
-- from requests
-- where source_contact ilike '%shaunak%' or source_contact ilike '%4443%';

-- Delete the duplicate entry (keep the one with the phone number).
-- Replace <UUID_WITHOUT_NUMBER> with the actual ID from the preview query above.
-- delete from matches where need_id = '<UUID_WITHOUT_NUMBER>' or offer_id = '<UUID_WITHOUT_NUMBER>';
-- delete from requests where id = '<UUID_WITHOUT_NUMBER>';

-- ============================================================
-- Step 3: Generic duplicate finder
-- Run this to find any other potential duplicates:
-- Same destination + same date + different contact but similar pattern
-- ============================================================

-- select a.id as id_a, a.source_contact as contact_a,
--        b.id as id_b, b.source_contact as contact_b,
--        a.request_destination, a.ride_plan_date
-- from requests a
-- join requests b on a.request_destination = b.request_destination
--   and a.ride_plan_date = b.ride_plan_date
--   and a.request_type = b.request_type
--   and a.id < b.id
--   and a.request_status = 'open'
--   and b.request_status = 'open';
