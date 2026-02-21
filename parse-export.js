/**
 * Parse raw WhatsApp export text through LLM and backfill into database.
 * Usage: node parse-export.js manual/allgroups.txt
 *
 * Handles multi-line messages, group separators (#group2, group 3),
 * and skips system messages.
 */

require('dotenv').config();

const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { parseMessage } = require('./parser');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MSG_RE = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\]\s*(.+?):\s*([\s\S]*)$/;

const SYSTEM_PATTERNS = [
    /^‎.*added/,
    /^‎This message was deleted/,
    /^‎.*changed/,
    /^‎You /,
    /^‎<This message was edited>/,
];

const GROUP_SEPARATOR_RE = /^#?group\s*\d+$/i;

function computeRequestHash({ sourceContact, type, category, destination, date }) {
    const parts = [
        sourceContact || '',
        type || '',
        category || '',
        (destination || '').toLowerCase().trim(),
        date || ''
    ].join('|');
    return crypto.createHash('sha256').update(parts).digest('hex').substring(0, 16);
}

function parseTimestamp(dateStr, timeStr) {
    const [month, day, year] = dateStr.split('/');
    const fullYear = year.length === 2 ? `20${year}` : year;
    return new Date(`${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${timeStr}`);
}

function parseExport(filePath) {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const messages = [];
    let currentGroup = 'Unknown Group';
    let current = null;

    for (const line of lines) {
        if (GROUP_SEPARATOR_RE.test(line.trim()) || line.trim().startsWith('#group') || /^group\s+\d+$/i.test(line.trim())) {
            if (current) messages.push(current);
            current = null;
            currentGroup = line.trim();
            continue;
        }

        // Check for group name headers like "[date] GroupName: You added GroupName"
        const match = MSG_RE.exec(line);
        if (match) {
            if (current) messages.push(current);

            const [, dateStr, timeStr, sender, body] = match;
            const cleanSender = sender.replace(/^~\s*/, '').replace(/^‪/, '').replace(/‬$/, '').trim();
            const ts = parseTimestamp(dateStr, timeStr);

            current = {
                timestamp: ts.toISOString(),
                sender: cleanSender,
                body: body.trim(),
                group: currentGroup
            };
        } else if (current) {
            current.body += '\n' + line;
        }
    }
    if (current) messages.push(current);

    return messages.filter(m => {
        if (!m.body || m.body.length < 5) return false;
        if (SYSTEM_PATTERNS.some(p => p.test(m.body))) return false;
        if (m.body.includes('‎') && (m.body.includes('added') || m.body.includes('deleted'))) return false;
        return true;
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run(filePath) {
    const messages = parseExport(filePath);
    console.log(`\n[Export Parser] ${messages.length} messages to process\n`);

    let logged = 0, saved = 0, dupes = 0, skipped = 0, errors = 0;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const body = msg.body.trim();

        process.stdout.write(`[${i + 1}/${messages.length}] ${msg.sender}: ${body.substring(0, 50)}${body.length > 50 ? '...' : ''}`);

        let parsed;
        try {
            parsed = await parseMessage(body, msg.sender);
        } catch (err) {
            console.log(` -> [LLM error] ${err.message}`);
            errors++;
            await delay(1000);
            continue;
        }

        const isActionable = parsed.isRequest || parsed.type === 'need' || parsed.type === 'offer';

        // Log to message_log
        await supabase.from('message_log').insert({
            source_group: msg.group,
            source_contact: msg.sender,
            sender_name: msg.sender,
            message_text: body,
            is_request: isActionable,
            parsed_data: parsed,
            created_at: msg.timestamp
        });
        logged++;

        if (!isActionable) {
            console.log(' -> skip');
            skipped++;
            await delay(300);
            continue;
        }

        const hash = computeRequestHash({
            sourceContact: msg.sender,
            type: parsed.type,
            category: parsed.category,
            destination: parsed.destination,
            date: parsed.date
        });

        const { data: existing } = await supabase
            .from('requests')
            .select('id')
            .eq('request_hash', hash)
            .eq('request_status', 'open')
            .limit(1)
            .single();

        if (existing) {
            console.log(` -> dupe`);
            dupes++;
            await delay(300);
            continue;
        }

        const { error: reqErr } = await supabase.from('requests').insert({
            source: 'export_backfill',
            source_group: msg.group,
            source_contact: msg.sender,
            request_type: parsed.type,
            request_category: parsed.category,
            ride_plan_date: parsed.date || null,
            request_origin: parsed.origin || null,
            request_destination: parsed.destination || null,
            request_details: parsed.details || {},
            raw_message: body,
            request_status: 'open',
            request_hash: hash,
            created_at: msg.timestamp
        });

        if (reqErr) {
            console.log(` -> [db error] ${reqErr.message}`);
            errors++;
        } else {
            console.log(` -> SAVED: ${parsed.type} ${parsed.category} -> ${parsed.destination || 'N/A'}`);
            saved++;
        }

        await delay(500);
    }

    console.log(`\n[Export Parser] Done!`);
    console.log(`  Messages logged: ${logged}`);
    console.log(`  Requests saved:  ${saved}`);
    console.log(`  Duplicates:      ${dupes}`);
    console.log(`  Skipped:         ${skipped}`);
    console.log(`  Errors:          ${errors}\n`);
}

const file = process.argv[2];
if (!file) {
    console.error('Usage: node parse-export.js <path-to-txt>');
    process.exit(1);
}

run(file).catch(err => {
    console.error('[Export Parser] Fatal:', err.message);
    process.exit(1);
});
