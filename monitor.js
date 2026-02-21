/**
 * Aggie Connect — System Monitor
 * TUI-style health dashboard for bot ops.
 * Usage: node monitor.js (runs on port 3001)
 */

require('dotenv').config();

const express = require('express');
const { exec } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.MONITOR_PORT || 3001;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── helpers ────────────────────────────────────────────────────────────────

function pm2List() {
    return new Promise(resolve => {
        exec('pm2 jlist', (err, stdout) => {
            if (err) return resolve(null);
            try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
        });
    });
}

function tailLog(path, n = 20) {
    return new Promise(resolve => {
        exec(`tail -n ${n} "${path}" 2>/dev/null`, (err, out) => resolve(out || ''));
    });
}

function fmtUptime(startMs) {
    const s = Math.floor((Date.now() - startMs) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function fmtAgo(isoStr) {
    if (!isoStr) return 'never';
    const s = Math.floor((Date.now() - new Date(isoStr)) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function fmtTs(isoStr, tz = 'America/Chicago') {
    if (!isoStr) return '—';
    return new Date(isoStr).toLocaleString('en-US', {
        timeZone: tz, hour12: false,
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });
}

function col(s, n, right = false) {
    s = String(s ?? '');
    return right ? s.padStart(n) : s.padEnd(n);
}

function bar(n, max, width = 20) {
    const filled = max > 0 ? Math.round((n / max) * width) : 0;
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── data fetchers ──────────────────────────────────────────────────────────

async function fetchAll() {
    const [
        pm2,
        { data: reqs },
        { data: matches, count: matchCount },
        { data: groups },
        { data: msgLog },
        { data: logErrors }
    ] = await Promise.all([
        pm2List(),
        sb.from('requests').select('request_type, request_status, created_at'),
        sb.from('matches').select('id', { count: 'exact', head: true }),
        sb.from('monitored_groups').select('name, group_id, active').order('name'),
        sb.from('message_log')
            .select('created_at, source_group, message_text, is_request, parsed_data, error')
            .order('created_at', { ascending: false })
            .limit(20),
        sb.from('message_log')
            .select('created_at, source_group, message_text, error')
            .not('error', 'is', null)
            .order('created_at', { ascending: false })
            .limit(8)
    ]);

    return { pm2, reqs: reqs || [], matchCount: matchCount || 0, groups: groups || [], msgLog: msgLog || [], logErrors: logErrors || [] };
}

// ── report builder ────────────────────────────────────────────────────────

async function buildReport() {
    const { pm2, reqs, matchCount, groups, msgLog, logErrors } = await fetchAll();
    const now = new Date();
    const nowStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false });

    const L = [];
    const ln = s => L.push(s ?? '');
    const hr = (c = '─', n = 72) => ln(c.repeat(n));
    const section = title => { ln(''); hr(); ln(`  ${title}`); hr(); };

    // ── header ──
    ln(`  AGGIE CONNECT — SYSTEM MONITOR                    ${nowStr} CST`);
    hr('═');

    // ── processes ──
    section('PROCESSES');
    if (!pm2) {
        ln('  [could not read pm2 — is pm2 running?]');
    } else {
        ln(`  ${'NAME'.padEnd(14)} ${'STATUS'.padEnd(10)} ${'UPTIME'.padEnd(10)} ${'RESTARTS'.padEnd(10)} ${'MEM'.padEnd(8)} CPU`);
        hr('·');
        for (const p of pm2) {
            const env = p.pm2_env || {};
            const status = env.status || '?';
            const uptime = env.pm_uptime ? fmtUptime(env.pm_uptime) : '—';
            const restarts = env.restart_time ?? '?';
            const mem = p.monit?.memory ? (Math.round(p.monit.memory / 1024 / 1024) + ' MB') : '—';
            const cpu = p.monit?.cpu !== undefined ? (p.monit.cpu + '%') : '—';
            const icon = status === 'online' ? '✓' : '✗';
            ln(`  ${icon} ${col(p.name, 13)} ${col(status, 10)} ${col(uptime, 10)} ${col(restarts, 10)} ${col(mem, 8)} ${cpu}`);
        }
    }

    // ── whatsapp state (inferred) ──
    section('WHATSAPP CONNECTION (inferred)');
    const botProc = (pm2 || []).find(p => p.name === 'aggie-bot');
    const lastMsg = msgLog[0];
    const lastMsgAgo = lastMsg ? fmtAgo(lastMsg.created_at) : 'no messages logged';
    const botRestarts = botProc?.pm2_env?.restart_time ?? '?';
    const botStatus = botProc?.pm2_env?.status;

    if (botStatus !== 'online') {
        ln(`  ✗ bot process is ${botStatus || 'unknown'}`);
    } else if (!lastMsg) {
        ln(`  ? bot is online but no messages have been logged yet`);
    } else {
        const secsSinceMsg = (Date.now() - new Date(lastMsg.created_at)) / 1000;
        const connIcon = secsSinceMsg < 600 ? '✓' : (secsSinceMsg < 3600 ? '~' : '?');
        ln(`  ${connIcon} Last message processed: ${lastMsgAgo}  (${fmtTs(lastMsg.created_at)})`);
        if (secsSinceMsg > 600) {
            ln(`  ! No messages parsed in ${Math.round(secsSinceMsg/60)}m — possible silent disconnect`);
            ln(`    (watchdog checks every 5m and will force-restart if state ≠ CONNECTED)`);
        }
    }
    ln(`  Restarts: ${botRestarts}   Watchdog: polls every 5m via client.getState()`);

    // ── groups ──
    section('MONITORED GROUPS');
    const active = groups.filter(g => g.active);
    const inactive = groups.filter(g => !g.active);
    ln(`  Active: ${active.length} / ${groups.length} total`);
    ln('');
    ln('  [x] = monitored    [ ] = known but inactive');
    ln('');
    for (const g of groups) {
        ln(`  ${g.active ? '[x]' : '[ ]'} ${g.name || g.group_id}`);
    }

    // ── database ──
    section('DATABASE');
    const open = reqs.filter(r => r.request_status === 'open');
    const matched = reqs.filter(r => r.request_status === 'matched');
    const needs = reqs.filter(r => r.request_type === 'need');
    const offers = reqs.filter(r => r.request_type === 'offer');
    const openNeeds = open.filter(r => r.request_type === 'need');
    const openOffers = open.filter(r => r.request_type === 'offer');
    const maxBar = Math.max(needs.length, offers.length, 1);

    ln(`  Total requests:  ${reqs.length}`);
    ln(`  Match records:   ${matchCount}`);
    ln('');
    ln(`  needs  ${col(needs.length, 4)}  ${bar(needs.length, maxBar, 24)}  open: ${openNeeds.length}`);
    ln(`  offers ${col(offers.length, 4)}  ${bar(offers.length, maxBar, 24)}  open: ${openOffers.length}`);
    ln(`  matched ${col(matched.length, 3)}`);

    // ── parser health ──
    section('PARSER HEALTH  (last 20 messages)');
    const total20 = msgLog.length;
    const trueCount = msgLog.filter(m => m.is_request).length;
    const errCount = msgLog.filter(m => m.error).length;
    const offerCount = msgLog.filter(m => m.parsed_data?.type === 'offer').length;
    const needCount  = msgLog.filter(m => m.parsed_data?.type === 'need').length;
    const maxP = Math.max(trueCount, total20 - trueCount, 1);

    ln(`  isRequest true   ${col(trueCount, 3)}  ${bar(trueCount, total20, 24)}  (saved to DB)`);
    ln(`  isRequest false  ${col(total20 - trueCount, 3)}  ${bar(total20 - trueCount, total20, 24)}  (casual / skipped)`);
    ln(`  errors           ${col(errCount, 3)}  ${errCount > 0 ? bar(errCount, total20, 24) : '                        '}`);
    ln('');
    ln(`  of true:  ${needCount} need  ${offerCount} offer`);

    // ── recent messages ──
    section('RECENT PARSED MESSAGES');
    ln(`  ${'TIME'.padEnd(12)} ${'isReq'.padEnd(6)} ${'TYPE'.padEnd(7)} ${'DEST'.padEnd(18)} ${'GROUP'.padEnd(26)} MESSAGE`);
    hr('·');
    for (const m of msgLog) {
        const ts = fmtTs(m.created_at);
        const flag = m.is_request ? '  ✓   ' : '  ·   ';
        const type = col(m.parsed_data?.type || (m.error ? 'ERR' : '—'), 7);
        const dest = col((m.parsed_data?.destination || '—').substring(0, 17), 18);
        const grp  = col((m.source_group || '—').substring(0, 25), 26);
        const txt  = (m.message_text || '').replace(/\n/g, ' ').substring(0, 45);
        ln(`  ${col(ts, 12)} ${flag} ${type} ${dest} ${grp} ${txt}`);
    }

    // ── parser errors ──
    if (logErrors.length > 0) {
        section('RECENT PARSER ERRORS');
        for (const e of logErrors) {
            const ts = fmtTs(e.created_at);
            const grp = (e.source_group || '').substring(0, 25);
            const err = (e.error || '').substring(0, 60);
            ln(`  ${ts}  ${col(grp, 26)} ${err}`);
        }
    }

    // ── pm2 error log tail ──
    section('PM2 ERROR LOG  (last 10 lines)');
    const raw = await tailLog('/root/.pm2/logs/aggie-bot-error.log', 15);
    const errLines = raw.trim().split('\n')
        .map(l => l.replace(/^0\|aggie-bo \| /, '').trim())
        .filter(l => l.length > 0)
        .slice(-10);
    if (errLines.length === 0) {
        ln('  (empty)');
    } else {
        for (const l of errLines) ln('  ' + l);
    }

    ln('');
    hr('═');
    ln(`  Auto-refreshes every 30s  ·  ?raw for plain text`);

    return L.join('\n');
}

// ── routes ────────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
    try {
        const report = await buildReport();
        if ('raw' in req.query) {
            return res.type('text/plain; charset=utf-8').send(report);
        }
        const escaped = report
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aggie Connect — Monitor</title>
<meta http-equiv="refresh" content="30">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body  { background: #0d1117; color: #c9d1d9; font-family: 'Courier New', Courier, monospace; font-size: 13px; padding: 20px 24px 40px; }
  pre  { white-space: pre; line-height: 1.65; }
  .footer { color: #444; font-size: 11px; margin-top: 16px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<pre>${escaped}</pre>
<p class="footer">
  <a href="/">refresh</a> &nbsp;·&nbsp;
  <a href="/?raw">raw text</a> &nbsp;·&nbsp;
  <a href="http://localhost:3000">→ ride dashboard</a>
</p>
</body>
</html>`);
    } catch (err) {
        res.type('text/plain').status(500).send('Error: ' + err.message + '\n' + err.stack);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Monitor] Running at http://localhost:${PORT}`);
});
