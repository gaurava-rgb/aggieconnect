/**
 * Supabase Database Client
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

/**
 * Log every message the bot sees (for auditing)
 */
async function logMessage({ sourceGroup, sourceContact, senderName, messageText, isRequest, parsedData, error }) {
    try {
        await supabase.from('message_log').insert({
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

/**
 * Save a new request (need or offer)
 */
async function saveRequest(data) {
    const { data: request, error } = await supabase
        .from('requests')
        .insert({
            source: data.source || 'whatsapp',
            source_group: data.sourceGroup,
            source_contact: data.sourceContact,
            type: data.type,
            category: data.category,
            date: data.date,
            origin: data.origin,
            destination: data.destination,
            details: data.details || {},
            raw_message: data.rawMessage,
            status: 'open'
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

/**
 * Find potential matches for a request
 */
async function findMatches(request) {
    const oppositeType = request.type === 'need' ? 'offer' : 'need';

    let query = supabase
        .from('requests')
        .select('*')
        .eq('category', request.category)
        .eq('type', oppositeType)
        .eq('status', 'open')
        .neq('id', request.id);

    if (request.category === 'ride' && request.destination) {
        query = query.eq('destination', request.destination);
    }

    if (request.date) {
        const date = new Date(request.date);
        const dayBefore = new Date(date);
        const dayAfter = new Date(date);
        dayBefore.setDate(date.getDate() - 1);
        dayAfter.setDate(date.getDate() + 1);

        query = query
            .gte('date', dayBefore.toISOString().split('T')[0])
            .lte('date', dayAfter.toISOString().split('T')[0]);
    }

    const { data: matches, error } = await query;

    if (error) {
        console.error('[DB] Error finding matches:', error.message);
        return [];
    }

    return matches || [];
}

/**
 * Save a match between two requests
 */
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
        .update({ status: 'matched' })
        .in('id', [needId, offerId]);

    console.log(`[DB] Match created: ${match.id}`);
    return match;
}

/**
 * Get stats
 */
async function getStats() {
    const { data: requests } = await supabase
        .from('requests')
        .select('type, category, status');

    return {
        total: requests?.length || 0,
        needs: requests?.filter(r => r.type === 'need').length || 0,
        offers: requests?.filter(r => r.type === 'offer').length || 0,
        open: requests?.filter(r => r.status === 'open').length || 0,
        matched: requests?.filter(r => r.status === 'matched').length || 0
    };
}

module.exports = {
    supabase,
    logMessage,
    saveRequest,
    findMatches,
    saveMatch,
    getStats
};
