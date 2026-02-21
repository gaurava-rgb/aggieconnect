/**
 * One-time script to:
 * 1. Normalize all existing request_destination and request_origin values
 * 2. Run batch matching across all open requests
 *
 * Usage: node rematch.js
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { normalizeLocation } = require('./normalize');
const { processRequest } = require('./matcher');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
    // Step 1: Normalize all destinations and origins
    console.log('\n[Rematch] Step 1: Normalizing locations...\n');

    const { data: requests, error } = await supabase
        .from('requests')
        .select('id, request_destination, request_origin')
        .eq('request_status', 'open');

    if (error) {
        console.error('Failed to load requests:', error.message);
        return;
    }

    let normalized = 0;
    for (const req of requests) {
        const normDest = normalizeLocation(req.request_destination);
        const normOrigin = normalizeLocation(req.request_origin);

        if (normDest !== req.request_destination || normOrigin !== req.request_origin) {
            await supabase
                .from('requests')
                .update({
                    request_destination: normDest,
                    request_origin: normOrigin
                })
                .eq('id', req.id);

            console.log(`  ${req.request_destination} -> ${normDest}`);
            normalized++;
        }
    }
    console.log(`\n  Normalized ${normalized} of ${requests.length} requests\n`);

    // Step 2: Run matching for all open requests
    console.log('[Rematch] Step 2: Running batch matching...\n');

    const { data: openRequests } = await supabase
        .from('requests')
        .select('*')
        .eq('request_status', 'open');

    let matchCount = 0;
    for (const req of openRequests) {
        const matches = await processRequest(req);
        if (matches.length > 0) {
            matchCount += matches.length;
            for (const m of matches) {
                console.log(`  MATCH: ${m.need.source_contact} (need) <-> ${m.offer.source_contact} (offer)`);
                console.log(`    ${m.need.request_destination} on ${m.need.ride_plan_date}`);
            }
        }
    }

    console.log(`\n[Rematch] Done! Created ${matchCount} new match(es)\n`);
}

run().catch(err => {
    console.error('[Rematch] Fatal:', err.message);
    process.exit(1);
});
