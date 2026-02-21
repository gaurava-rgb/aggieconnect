/**
 * Backfill script - imports pre-parsed historical messages into the database.
 * Usage: node backfill.js manual/parse1.json
 */

require('dotenv').config();

const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

async function backfill(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries = JSON.parse(raw);

    console.log(`\n[Backfill] Loading ${entries.length} entries from ${filePath}\n`);

    let logged = 0, saved = 0, dupes = 0, skipped = 0;

    for (const entry of entries) {
        const parsed = entry.parsed_data || {};
        const isActionable = parsed.type === 'need' || parsed.type === 'offer';

        // 1. Log to message_log
        const { error: logErr } = await supabase.from('message_log').insert({
            source_group: entry.source_group,
            source_contact: entry.source_contact,
            sender_name: entry.sender_name,
            message_text: entry.message_text,
            is_request: isActionable,
            parsed_data: parsed,
            created_at: entry.created_at || new Date().toISOString()
        });

        if (logErr) {
            console.error(`  [log error] ${entry.sender_name}: ${logErr.message}`);
        } else {
            logged++;
        }

        // 2. Save actionable items to requests
        if (!isActionable) {
            skipped++;
            console.log(`  [skip] ${entry.sender_name}: not actionable`);
            continue;
        }

        const hash = computeRequestHash({
            sourceContact: entry.source_contact,
            type: parsed.type,
            category: parsed.category,
            destination: parsed.destination,
            date: parsed.date
        });

        // Check for existing open request with same hash
        const { data: existing } = await supabase
            .from('requests')
            .select('id')
            .eq('request_hash', hash)
            .eq('request_status', 'open')
            .limit(1)
            .single();

        if (existing) {
            dupes++;
            console.log(`  [dupe] ${entry.sender_name}: ${parsed.type} ${parsed.category} -> ${parsed.destination}`);
            continue;
        }

        const { error: reqErr } = await supabase.from('requests').insert({
            source: 'manual_backfill',
            source_group: entry.source_group,
            source_contact: entry.source_contact,
            request_type: parsed.type,
            request_category: parsed.category,
            ride_plan_date: parsed.date || null,
            request_origin: parsed.origin || null,
            request_destination: parsed.destination || null,
            request_details: parsed.details || {},
            raw_message: entry.message_text,
            request_status: 'open',
            request_hash: hash,
            created_at: entry.created_at || new Date().toISOString()
        });

        if (reqErr) {
            console.error(`  [req error] ${entry.sender_name}: ${reqErr.message}`);
        } else {
            saved++;
            console.log(`  [saved] ${entry.sender_name}: ${parsed.type} ${parsed.category} -> ${parsed.destination} on ${parsed.date}`);
        }
    }

    console.log(`\n[Backfill] Done!`);
    console.log(`  Messages logged: ${logged}`);
    console.log(`  Requests saved:  ${saved}`);
    console.log(`  Duplicates:      ${dupes}`);
    console.log(`  Skipped (not actionable): ${skipped}\n`);
}

const file = process.argv[2];
if (!file) {
    console.error('Usage: node backfill.js <path-to-json>');
    process.exit(1);
}

backfill(file).catch(err => {
    console.error('[Backfill] Fatal error:', err.message);
    process.exit(1);
});
