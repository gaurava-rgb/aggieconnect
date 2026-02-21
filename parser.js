/**
 * LLM Parser - Uses OpenRouter to extract structured data from messages
 */

const OpenAI = require('openai');

const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY
});

const MODEL = process.env.LLM_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';

function buildSystemPrompt() {
    const today = new Date().toISOString().split('T')[0];
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    return `You are a message parser for a university ride-sharing platform at Texas A&M.
Analyze WhatsApp messages and extract structured information.

IMPORTANT: Most messages are casual chat. Only extract data when someone is clearly:
- Looking for a ride or offering a ride
- Asking for help or offering help

For casual messages (greetings, jokes, replies, reactions, thank yous), return:
{"isRequest": false}

When you detect a valid request or offer, return:
{
  "isRequest": true,
  "type": "need" or "offer",
  "category": "ride",
  "date": "YYYY-MM-DD" or null,
  "origin": "location" or null,
  "destination": "location" or null,
  "details": {
    "seats": number or null,
    "gasContribution": string or null,
    "time": string or null,
    "description": string
  }
}

isRequest = true for BOTH needs (looking for a ride) AND offers (providing a ride).
isRequest = false ONLY for casual chat (greetings, reactions, replies, thank yous).

Common patterns (all return isRequest: true):
- "anyone going to Houston?" -> need, ride
- "can drop 2 people to DFW" -> offer, ride
- "need ride to IAH Friday" -> need, ride
- "driving to Dallas, 3 spots" -> offer, ride
- "Ride available from CS to Dallas" -> offer, ride
- "Ride available tomorrow to Houston" -> offer, ride
- "giving ride to Houston Friday" -> offer, ride
- "offering ride to DFW this weekend" -> offer, ride
- "need help moving" -> need, help
- "can help with groceries" -> offer, help

Today is ${dayName}, ${today}. Resolve relative dates:
- "tomorrow" -> next day
- "Friday" -> the upcoming Friday
- "this weekend" -> upcoming Saturday

Normalize destinations:
- "Houston airport" / "IAH" / "Bush" -> "Houston IAH"
- "Hobby" -> "Houston Hobby"
- "DFW" / "Dallas airport" -> "Dallas DFW"
- "CS" / "cstat" / "College Station" -> "College Station"

Default origin is "College Station" if not specified and category is ride.

ONLY return valid JSON. No explanation, no markdown.`;
}

async function parseMessage(message, senderName = '') {
    if (!message || message.length < 5) {
        return { isRequest: false };
    }

    const skipPatterns = [
        /^(hi|hey|hello|thanks|thank you|ok|okay|lol|haha|yes|no|sure|nice|cool|great|good|bye|gm|gn|sup|yo|bruh|bro)[\s!.?]*$/i,
        /^[\p{Emoji}\s]+$/u,
        /^https?:\/\//i
    ];

    if (skipPatterns.some(p => p.test(message.trim()))) {
        return { isRequest: false };
    }

    try {
        const response = await openai.chat.completions.create({
            model: MODEL,
            messages: [
                { role: 'system', content: buildSystemPrompt() },
                { role: 'user', content: `Message from ${senderName || 'user'}:\n"${message}"` }
            ],
            temperature: 0.1,
            max_tokens: 300
        });

        const content = response.choices[0]?.message?.content?.trim();
        if (!content) return { isRequest: false };

        let jsonStr = content;
        const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) jsonStr = codeBlock[1].trim();

        const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objectMatch) jsonStr = objectMatch[0];

        const parsed = JSON.parse(jsonStr);

        if (parsed.isRequest) {
            if (parsed.category === 'ride' && !parsed.origin) {
                parsed.origin = 'College Station';
            }
            console.log(`[Parser] Extracted: ${parsed.type} ${parsed.category} -> ${parsed.destination || 'N/A'} on ${parsed.date || 'N/A'}`);
        }

        return parsed;

    } catch (error) {
        console.error('[Parser] Error:', error.message?.substring(0, 100));
        return { isRequest: false, _error: error.message };
    }
}

module.exports = { parseMessage };
