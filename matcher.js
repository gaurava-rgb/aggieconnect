/**
 * Matching Engine - Finds and stores matches between needs and offers
 */

const db = require('./db');

async function processRequest(request) {
    console.log(`[Matcher] Processing ${request.type} for ${request.category}`);

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

        const needId = request.type === 'need' ? request.id : match.id;
        const offerId = request.type === 'offer' ? request.id : match.id;

        const saved = await db.saveMatch(needId, offerId, score);
        if (saved) {
            savedMatches.push({
                match: saved,
                need: request.type === 'need' ? request : match,
                offer: request.type === 'offer' ? request : match
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

    if (request.date && match.date) {
        const daysDiff = Math.abs(
            (new Date(request.date) - new Date(match.date)) / (1000 * 60 * 60 * 24)
        );
        if (daysDiff === 0) score *= 1.0;
        else if (daysDiff === 1) score *= 0.8;
        else score *= 0.5;
    }

    if (request.category === 'ride' && request.destination && match.destination) {
        if (normalize(request.destination) === normalize(match.destination)) {
            score *= 1.0;
        } else {
            score *= 0.6;
        }

        if (request.origin && match.origin && normalize(request.origin) === normalize(match.origin)) {
            score = Math.min(score * 1.1, 1.0);
        }
    }

    return score;
}

function normalize(location) {
    if (!location) return '';
    const s = location.toLowerCase().trim();
    const map = {
        'houston iah': ['iah', 'bush', 'george bush', 'houston airport', 'houston intl'],
        'houston hobby': ['hobby', 'hou'],
        'dallas dfw': ['dfw', 'dallas airport', 'dallas/fort worth'],
        'college station': ['cs', 'cstat', 'c station']
    };
    for (const [standard, variants] of Object.entries(map)) {
        if (variants.some(v => s.includes(v)) || s.includes(standard)) return standard;
    }
    return s;
}

function formatMatch(matchData) {
    const { need, offer } = matchData;
    let msg = 'Match Found!\n\n';
    if (need.category === 'ride') {
        msg += `Ride to ${need.destination || 'TBD'}\n`;
        msg += `Date: ${need.date || 'Flexible'}\n\n`;
        msg += `Looking: ${need.source_contact}\n`;
        msg += `Offering: ${offer.source_contact}\n`;
    } else {
        msg += `${need.category}: ${need.details?.description || 'Help needed'}\n\n`;
        msg += `Needs help: ${need.source_contact}\n`;
        msg += `Can help: ${offer.source_contact}\n`;
    }
    return msg;
}

module.exports = { processRequest, formatMatch };
