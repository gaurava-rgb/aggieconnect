/**
 * Supabase Database Client
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { normalizeLocation } = require('./normalize');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// ============================================================
// Monitored Groups
// ============================================================

async function loadMonitoredGroups() {
    const { data, error } = await supabase
        .from('monitored_groups')
        .select('group_id, group_name')
        .eq('active', true);

    if (error) {
        console.error('[DB] Error loading monitored groups:', error.message);
        return [];
    }
    return data || [];
}

async function getGroupUpdates(since) {
    const { data, error } = await supabase
        .from('monitored_groups')
        .select('updated_at')
        .gt('updated_at', since.toISOString())
        .limit(1);

    if (error) {
        console.error('[DB] Error checking group updates:', error.message);
        return false;
    }
    return data && data.length > 0;
}

async function seedGroups(groups) {
    for (const g of groups) {
        await supabase
            .from('monitored_groups')
            .upsert(
                { group_id: g.id, group_name: g.name },
                { onConflict: 'group_id', ignoreDuplicates: true }
            );
    }
}

// ============================================================
// Message Log
// ============================================================

async function logMessage({ waMessageId, sourceGroup, sourceContact, senderName, messageText, isRequest, parsedData, error }) {
    try {
        await supabase.from('message_log').insert({
            wa_message_id: waMessageId || null,
            source_group: sourceGroup,
            source_contact: sourceContact,
            sender_name: senderName,
            message_text: messageText,
            is_request: isRequest,
            parsed_data: parsedData || null,
            error: error || null
        });
    } catch (err) {
        console.error('[DB] Failed to log message:', err.message);
    }
}

async function messageAlreadyProcessed(waMessageId) {
    if (!waMessageId) return false;
    const { data, error } = await supabase
        .from('message_log')
        .select('id')
        .eq('wa_message_id', waMessageId)
        .limit(1)
        .maybeSingle();
    if (error) return false;
    return !!data;
}

// ============================================================
// Request Dedup
// ============================================================

function computeRequestHash({ sourceContact, type, category, destination, date }) {
    const normDest = normalizeLocation(destination) || '';
    const parts = [
        sourceContact || '',
        type || '',
        category || '',
        normDest.toLowerCase(),
        date || ''
    ].join('|');
    return crypto.createHash('sha256').update(parts).digest('hex').substring(0, 16);
}

async function findExistingRequest(hash) {
    const { data } = await supabase
        .from('requests')
        .select('id, source_group')
        .eq('request_hash', hash)
        .eq('request_status', 'open')
        .limit(1)
        .single();
    return data;
}

// ============================================================
// Save Request (with dedup)
// ============================================================

async function saveRequest(data) {
    const hash = computeRequestHash({
        sourceContact: data.sourceContact,
        type: data.type,
        category: data.category,
        destination: data.destination,
        date: data.date
    });

    const existing = await findExistingRequest(hash);
    if (existing) {
        console.log(`[DB] Duplicate request (matches ${existing.id} from ${existing.source_group}), skipping`);
        return null;
    }

    const normOrigin = normalizeLocation(data.origin);
    const normDest = normalizeLocation(data.destination);

    const { data: request, error } = await supabase
        .from('requests')
        .insert({
            source: data.source || 'whatsapp',
            source_group: data.sourceGroup,
            source_contact: data.sourceContact,
            request_type: data.type,
            request_category: data.category,
            ride_plan_date: data.date,
            request_origin: normOrigin,
            request_destination: normDest,
            request_details: data.details || {},
            raw_message: data.rawMessage,
            request_status: 'open',
            request_hash: hash
        })
        .select()
        .single();

    if (error) {
        console.error('[DB] Error saving request:', error.message);
        return null;
    }

    console.log(`[DB] Saved ${data.type} for ${data.category}: ${request.id}`);
    return request;
}

// ============================================================
// Matching
// ============================================================

async function findMatches(request) {
    const oppositeType = request.request_type === 'need' ? 'offer' : 'need';

    let query = supabase
        .from('requests')
        .select('*')
        .eq('request_category', request.request_category)
        .eq('request_type', oppositeType)
        .eq('request_status', 'open')
        .neq('id', request.id);

    if (request.request_category === 'ride' && request.request_destination) {
        query = query.eq('request_destination', request.request_destination);
    }

    if (request.ride_plan_date) {
        const date = new Date(request.ride_plan_date);
        const dayBefore = new Date(date);
        const dayAfter = new Date(date);
        dayBefore.setDate(date.getDate() - 1);
        dayAfter.setDate(date.getDate() + 1);

        query = query
            .gte('ride_plan_date', dayBefore.toISOString().split('T')[0])
            .lte('ride_plan_date', dayAfter.toISOString().split('T')[0]);
    }

    const { data: matches, error } = await query;

    if (error) {
        console.error('[DB] Error finding matches:', error.message);
        return [];
    }

    return matches || [];
}

async function saveMatch(needId, offerId, score = 1.0) {
    const { data: existing } = await supabase
        .from('matches')
        .select('id')
        .or(`and(need_id.eq.${needId},offer_id.eq.${offerId}),and(need_id.eq.${offerId},offer_id.eq.${needId})`)
        .single();

    if (existing) return null;

    const { data: match, error } = await supabase
        .from('matches')
        .insert({
            need_id: needId,
            offer_id: offerId,
            score,
            notified: false
        })
        .select()
        .single();

    if (error) {
        console.error('[DB] Error saving match:', error.message);
        return null;
    }

    await supabase
        .from('requests')
        .update({ request_status: 'matched' })
        .in('id', [needId, offerId]);

    console.log(`[DB] Match created: ${match.id}`);
    return match;
}

// ============================================================
// Stats
// ============================================================

async function getStats() {
    const { data: requests } = await supabase
        .from('requests')
        .select('request_type, request_category, request_status');

    return {
        total: requests?.length || 0,
        needs: requests?.filter(r => r.request_type === 'need').length || 0,
        offers: requests?.filter(r => r.request_type === 'offer').length || 0,
        open: requests?.filter(r => r.request_status === 'open').length || 0,
        matched: requests?.filter(r => r.request_status === 'matched').length || 0
    };
}

module.exports = {
    supabase,
    loadMonitoredGroups,
    getGroupUpdates,
    seedGroups,
    logMessage,
    messageAlreadyProcessed,
    computeRequestHash,
    saveRequest,
    findMatches,
    saveMatch,
    getStats
};
