/**
 * Matching Engine - Finds and stores matches between needs and offers
 */

const db = require('./db');
const { normalizeLocation } = require('./normalize');

async function processRequest(request) {
    console.log(`[Matcher] Processing ${request.request_type} for ${request.request_category}`);

    const potentialMatches = await db.findMatches(request);

    if (potentialMatches.length === 0) {
        console.log('[Matcher] No matches found');
        return [];
    }

    console.log(`[Matcher] Found ${potentialMatches.length} potential match(es)`);

    const savedMatches = [];

    for (const match of potentialMatches) {
        const score = calculateScore(request, match);
        if (score < 0.5) continue;

        const needId = request.request_type === 'need' ? request.id : match.id;
        const offerId = request.request_type === 'offer' ? request.id : match.id;

        const saved = await db.saveMatch(needId, offerId, score);
        if (saved) {
            savedMatches.push({
                match: saved,
                need: request.request_type === 'need' ? request : match,
                offer: request.request_type === 'offer' ? request : match
            });
        }
    }

    if (savedMatches.length > 0) {
        console.log(`[Matcher] Created ${savedMatches.length} new match(es)`);
    }

    return savedMatches;
}

function calculateScore(request, match) {
    let score = 1.0;

    if (request.ride_plan_date && match.ride_plan_date) {
        const daysDiff = Math.abs(
            (new Date(request.ride_plan_date) - new Date(match.ride_plan_date)) / (1000 * 60 * 60 * 24)
        );
        if (daysDiff === 0) score *= 1.0;
        else if (daysDiff === 1) score *= 0.8;
        else score *= 0.5;
    }

    if (request.request_category === 'ride' && request.request_destination && match.request_destination) {
        if (normalizeLocation(request.request_destination) === normalizeLocation(match.request_destination)) {
            score *= 1.0;
        } else {
            score *= 0.6;
        }

        if (request.request_origin && match.request_origin && normalizeLocation(request.request_origin) === normalizeLocation(match.request_origin)) {
            score = Math.min(score * 1.1, 1.0);
        }
    }

    return score;
}

function formatMatch(matchData) {
    const { need, offer } = matchData;
    let msg = 'Match Found!\n\n';
    if (need.request_category === 'ride') {
        msg += `Ride to ${need.request_destination || 'TBD'}\n`;
        msg += `Date: ${need.ride_plan_date || 'Flexible'}\n\n`;
        msg += `Looking: ${need.source_contact}\n`;
        msg += `Offering: ${offer.source_contact}\n`;
    } else {
        msg += `${need.request_category}: ${need.request_details?.description || 'Help needed'}\n\n`;
        msg += `Needs help: ${need.source_contact}\n`;
        msg += `Can help: ${offer.source_contact}\n`;
    }
    return msg;
}

module.exports = { processRequest, formatMatch };
