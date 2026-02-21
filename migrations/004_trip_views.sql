-- Trip views for grouped match display
-- Run this in Supabase SQL Editor

-- Flat view: one row per match with driver + rider info
create or replace view trip_board as
select
  m.id as match_id,
  m.score as match_score,
  m.created_at as matched_at,
  o.id as offer_id,
  o.source_contact as driver_contact,
  o.source_group as driver_group,
  o.request_destination as destination,
  o.request_origin as origin,
  o.ride_plan_date as ride_date,
  o.request_details as offer_details,
  n.id as need_id,
  n.source_contact as rider_contact,
  n.source_group as rider_group,
  n.ride_plan_date as rider_date,
  n.request_details as need_details
from matches m
join requests o on o.id = m.offer_id
join requests n on n.id = m.need_id
order by o.ride_plan_date, o.request_destination;

-- Summary view: one row per driver with aggregated riders
create or replace view trip_summary as
select
  o.id as offer_id,
  o.source_contact as driver_contact,
  o.request_destination as destination,
  o.request_origin as origin,
  o.ride_plan_date as ride_date,
  o.request_details->>'time' as ride_time,
  o.request_details->>'seats' as seats_offered,
  count(m.id) as riders_matched,
  array_agg(n.source_contact) as rider_contacts,
  array_agg(n.ride_plan_date) as rider_dates
from requests o
join matches m on m.offer_id = o.id
join requests n on n.id = m.need_id
group by o.id
order by o.ride_plan_date;
