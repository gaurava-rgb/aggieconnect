/**
 * Aggie Connect Dashboard
 * Visual trip board and request overview.
 * Usage: node dashboard.js (runs on port 3000)
 */

require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getTrips() {
    const { data } = await supabase
        .from('matches')
        .select(`
            id, score, created_at,
            offer:offer_id(id, source_contact, source_group, request_destination, request_origin, ride_plan_date, request_details),
            need:need_id(id, source_contact, source_group, request_destination, ride_plan_date, request_details)
        `)
        .order('created_at', { ascending: false });

    const grouped = {};
    for (const m of (data || [])) {
        const offerId = m.offer?.id;
        if (!offerId) continue;
        if (!grouped[offerId]) {
            grouped[offerId] = {
                offer: m.offer,
                riders: []
            };
        }
        grouped[offerId].riders.push({
            ...m.need,
            match_id: m.id,
            score: m.score
        });
    }
    return Object.values(grouped).sort((a, b) =>
        new Date(a.offer.ride_plan_date || 0) - new Date(b.offer.ride_plan_date || 0)
    );
}

async function getOpenRequests() {
    const { data } = await supabase
        .from('requests')
        .select('*')
        .eq('request_status', 'open')
        .order('ride_plan_date', { ascending: true });
    return data || [];
}

async function getDemand() {
    const today = new Date().toISOString().split('T')[0];
    const { data: rows } = await supabase
        .from('requests')
        .select('ride_plan_date, request_origin, request_destination, source_contact')
        .eq('request_type', 'need')
        .eq('request_status', 'open')
        .not('ride_plan_date', 'is', null)
        .gte('ride_plan_date', today)
        .order('ride_plan_date', { ascending: true });

    const grouped = {};
    for (const r of (rows || [])) {
        const dest = r.request_destination || '?';
        const orig = r.request_origin || '?';
        const key = r.ride_plan_date + '|' + orig + '|' + dest;
        if (!grouped[key]) {
            grouped[key] = {
                date: r.ride_plan_date,
                origin: orig,
                destination: dest,
                count: 0,
                contacts: []
            };
        }
        grouped[key].count++;
        if (r.source_contact) grouped[key].contacts.push(r.source_contact);
    }

    const demand = Object.values(grouped).sort((a, b) =>
        a.date.localeCompare(b.date) || b.count - a.count
    );

    const byDate = {};
    for (const d of demand) {
        if (!byDate[d.date]) byDate[d.date] = [];
        byDate[d.date].push(d);
    }
    return byDate;
}

async function getStats() {
    const { data: requests } = await supabase
        .from('requests')
        .select('request_type, request_status');
    const { data: matches } = await supabase
        .from('matches')
        .select('id');
    const { data: groups } = await supabase
        .from('monitored_groups')
        .select('group_id')
        .eq('active', true);

    const r = requests || [];
    return {
        total: r.length,
        open: r.filter(x => x.request_status === 'open').length,
        matched: r.filter(x => x.request_status === 'matched').length,
        needs: r.filter(x => x.request_type === 'need').length,
        offers: r.filter(x => x.request_type === 'offer').length,
        matches: (matches || []).length,
        groups: (groups || []).length
    };
}

function formatDate(d) {
    if (!d) return 'Flexible';
    const date = new Date(d + 'T00:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function dayOffset(driverDate, riderDate) {
    if (!driverDate || !riderDate) return null;
    const d = new Date(driverDate + 'T00:00:00');
    const r = new Date(riderDate + 'T00:00:00');
    return Math.round((r - d) / (1000 * 60 * 60 * 24));
}

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function classifyRiders(riders, offerDate) {
    const exact = [];
    const nearby = [];
    for (const r of riders) {
        const offset = dayOffset(offerDate, r.ride_plan_date);
        r._offset = offset;
        if (offset === 0) exact.push(r);
        else nearby.push(r);
    }
    exact.sort((a, b) => (a.source_contact || '').localeCompare(b.source_contact || ''));
    nearby.sort((a, b) => Math.abs(a._offset ?? 99) - Math.abs(b._offset ?? 99));
    return { exact, nearby };
}

function findDuplicateContacts(riders) {
    const counts = {};
    for (const r of riders) {
        const c = (r.source_contact || '').trim();
        if (c) counts[c] = (counts[c] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter(k => counts[k] > 1));
}

app.get('/', async (req, res) => {
    try {
        const [trips, openReqs, stats, demandByDate] = await Promise.all([
            getTrips(), getOpenRequests(), getStats(), getDemand()
        ]);

        const openNeeds = openReqs.filter(r => r.request_type === 'need');
        const openOffers = openReqs.filter(r => r.request_type === 'offer');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aggie Connect</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f8f8; color: #1a1a1a; line-height: 1.5; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.3px; }
  h1 span { color: #888; font-weight: 400; }
  .stats { display: flex; gap: 12px; margin: 20px 0; flex-wrap: wrap; }
  .stat { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; min-width: 100px; }
  .stat-val { font-size: 24px; font-weight: 600; }
  .stat-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
  .section { margin-top: 32px; }
  .section-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 12px; border-bottom: 1px solid #e5e5e5; padding-bottom: 8px; }
  .trip-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .trip-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
  .trip-dest { font-size: 16px; font-weight: 600; }
  .trip-date { font-size: 13px; color: #666; background: #f0f0f0; padding: 2px 8px; border-radius: 4px; }
  .trip-driver { font-size: 13px; color: #555; margin-bottom: 8px; }
  .trip-driver strong { color: #1a1a1a; }
  .trip-time { font-size: 12px; color: #888; }
  .riders { border-top: 1px solid #f0f0f0; padding-top: 8px; margin-top: 8px; }
  .riders-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .rider { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; }
  .rider-contact { color: #333; }
  .rider-date { color: #888; font-size: 12px; }
  .score { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; }
  .score-exact { background: #22c55e; }
  .score-nearby { background: #f59e0b; }
  .offset-tag { font-size: 11px; color: #b45309; background: #fef3c7; padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
  .dup-tag { font-size: 10px; color: #9333ea; background: #f3e8ff; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
  .tier-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin: 8px 0 4px; }
  .tier-sep { border-top: 1px dashed #e5e5e5; margin-top: 6px; padding-top: 6px; }
  .rider-origin-diff { font-size: 11px; color: #999; margin-left: 6px; }
  .demand-date { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .demand-date-header { font-size: 15px; font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
  .demand-date-total { font-size: 12px; color: #888; font-weight: 400; }
  .demand-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
  .demand-row:last-child { border-bottom: none; }
  .demand-route { font-size: 14px; font-weight: 500; }
  .demand-count { font-size: 20px; font-weight: 600; color: #3b82f6; min-width: 40px; text-align: center; }
  .demand-people { font-size: 11px; color: #888; }
  .demand-bar { height: 4px; background: #3b82f6; border-radius: 2px; margin-top: 4px; min-width: 8px; }
  .req-list { display: grid; gap: 8px; }
  .req-item { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
  .req-info { flex: 1; }
  .req-route { font-size: 14px; font-weight: 500; }
  .req-meta { font-size: 12px; color: #888; margin-top: 2px; }
  .req-date { font-size: 13px; color: #666; background: #f0f0f0; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
  .badge-need { border-left: 3px solid #3b82f6; }
  .badge-offer { border-left: 3px solid #22c55e; }
  .empty { color: #aaa; font-size: 14px; padding: 24px; text-align: center; }
  .refresh { float: right; font-size: 12px; color: #888; text-decoration: none; border: 1px solid #ddd; padding: 4px 12px; border-radius: 4px; }
  .refresh:hover { background: #f0f0f0; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 640px) { .two-col { grid-template-columns: 1fr; } .stats { gap: 8px; } .stat { min-width: 80px; padding: 8px 12px; } }
</style>
</head>
<body>
<div class="container">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <h1>Aggie Connect <span>Dashboard</span></h1>
    <a href="/" class="refresh">Refresh</a>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-val">${stats.total}</div><div class="stat-label">Requests</div></div>
    <div class="stat"><div class="stat-val">${stats.matches}</div><div class="stat-label">Matches</div></div>
    <div class="stat"><div class="stat-val">${stats.open}</div><div class="stat-label">Open</div></div>
    <div class="stat"><div class="stat-val">${stats.needs}</div><div class="stat-label">Needs</div></div>
    <div class="stat"><div class="stat-val">${stats.offers}</div><div class="stat-label">Offers</div></div>
    <div class="stat"><div class="stat-val">${stats.groups}</div><div class="stat-label">Groups</div></div>
  </div>

  <div class="section">
    <div class="section-title">Demand Board — People Looking for Rides</div>
    ${Object.keys(demandByDate).length === 0 ? '<div class="empty">No open ride needs with dates</div>' :
      Object.entries(demandByDate).map(([date, routes]) => {
        const total = routes.reduce((s, r) => s + r.count, 0);
        const maxCount = Math.max(...routes.map(r => r.count));
        return `<div class="demand-date">
          <div class="demand-date-header">
            <span>${formatDate(date)}</span>
            <span class="demand-date-total">${total} ${total === 1 ? 'person looking' : 'people looking'} for a ride</span>
          </div>
          ${routes.map(r => {
            const barWidth = Math.round((r.count / maxCount) * 100);
            const pLabel = r.count === 1 ? 'person needs' : 'people need';
            return `<div class="demand-row">
              <div style="flex:1">
                <div class="demand-route">${escHtml(r.origin)} → ${escHtml(r.destination)}</div>
                <div class="demand-people">${r.count} ${pLabel} a ride</div>
                <div class="demand-bar" style="width:${barWidth}%"></div>
              </div>
              <div class="demand-count">${r.count}</div>
            </div>`;
          }).join('')}
        </div>`;
      }).join('')}
  </div>

  <div class="section">
    <div class="section-title">Matched Trips (${trips.length})</div>
    ${trips.length === 0 ? '<div class="empty">No matched trips yet</div>' : trips.map(t => {
        const o = t.offer;
        const time = o.request_details?.time || '';
        const { exact, nearby } = classifyRiders(t.riders, o.ride_plan_date);
        const dupes = findDuplicateContacts(t.riders);

        function renderRider(r, tier) {
            const offsetVal = r._offset;
            const offsetLabel = tier === 'nearby' && offsetVal != null
                ? (offsetVal > 0 ? `+${offsetVal} day` : `${offsetVal} day`)
                : '';
            const isDup = dupes.has((r.source_contact || '').trim());
            const originDiff = r.request_origin && o.request_origin
                && r.request_origin.toLowerCase() !== o.request_origin.toLowerCase()
                ? r.request_origin : '';
            return '<div class="rider">' +
              '<span class="rider-contact">' +
                '<span class="score score-' + tier + '"></span>' +
                escHtml(r.source_contact) +
                (originDiff ? '<span class="rider-origin-diff">from ' + escHtml(originDiff) + '</span>' : '') +
                (isDup ? '<span class="dup-tag">dup?</span>' : '') +
              '</span>' +
              '<span class="rider-date">' +
                formatDate(r.ride_plan_date) +
                (offsetLabel ? '<span class="offset-tag">' + offsetLabel + '</span>' : '') +
              '</span>' +
            '</div>';
        }

        return `<div class="trip-card">
      <div class="trip-header">
        <div>
          <div class="trip-dest">${escHtml(o.request_origin || '?')} → ${escHtml(o.request_destination || '?')}</div>
          <div class="trip-driver">Driver: <strong>${escHtml(o.source_contact)}</strong></div>
          ${time ? `<div class="trip-time">${escHtml(time)}</div>` : ''}
        </div>
        <div class="trip-date">${formatDate(o.ride_plan_date)}</div>
      </div>
      <div class="riders">
        <div class="riders-label">${t.riders.length} rider${t.riders.length !== 1 ? 's' : ''} matched</div>
        ${exact.length > 0 ? '<div class="tier-label">Exact date (' + exact.length + ')</div>' + exact.map(r => renderRider(r, 'exact')).join('') : ''}
        ${nearby.length > 0 ? '<div class="tier-sep"></div><div class="tier-label">Nearby date (' + nearby.length + ')</div>' + nearby.map(r => renderRider(r, 'nearby')).join('') : ''}
      </div>
    </div>`;
    }).join('')}
  </div>

  <div class="section">
    <div class="section-title">Open Requests</div>
    <div class="two-col">
      <div>
        <div class="section-title" style="font-size:12px;border:none;margin-bottom:8px">Needs (${openNeeds.length})</div>
        <div class="req-list">
          ${openNeeds.length === 0 ? '<div class="empty">None</div>' : openNeeds.map(r => `
            <div class="req-item badge-need">
              <div class="req-info">
                <div class="req-route">${escHtml(r.request_origin || '?')} → ${escHtml(r.request_destination || '?')}</div>
                <div class="req-meta">${escHtml(r.source_contact)} · ${escHtml(r.source_group || '')}</div>
              </div>
              <div class="req-date">${formatDate(r.ride_plan_date)}</div>
            </div>`).join('')}
        </div>
      </div>
      <div>
        <div class="section-title" style="font-size:12px;border:none;margin-bottom:8px">Offers (${openOffers.length})</div>
        <div class="req-list">
          ${openOffers.length === 0 ? '<div class="empty">None</div>' : openOffers.map(r => `
            <div class="req-item badge-offer">
              <div class="req-info">
                <div class="req-route">${escHtml(r.request_origin || '?')} → ${escHtml(r.request_destination || '?')}</div>
                <div class="req-meta">${escHtml(r.source_contact)} · ${escHtml(r.source_group || '')}</div>
              </div>
              <div class="req-date">${formatDate(r.ride_plan_date)}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>
  </div>

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#aaa;text-align:center">
    Aggie Connect · Auto-refreshes on page load · Data from Supabase
  </div>
</div>
</body>
</html>`;

        res.send(html);
    } catch (err) {
        console.error('[Dashboard] Error:', err.message);
        res.status(500).send('Error loading dashboard');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Dashboard] Running at http://localhost:${PORT}`);
});
