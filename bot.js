/**
 * Aggie Connect - WhatsApp Bot
 * Listens to group messages, parses with LLM, stores in Supabase, finds matches
 */

require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { parseMessage } = require('./parser');
const { saveRequest, logMessage, getStats } = require('./db');
const { processRequest, formatMatch } = require('./matcher');

const TARGET_GROUPS = (process.env.TARGET_GROUPS || '')
    .split(',')
    .map(g => g.trim())
    .filter(Boolean);

const processedMessages = new Set();
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

function createClient() {
    return new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run'
            ]
        }
    });
}

let client = createClient();

// QR Code
client.on('qr', (qr) => {
    console.log('\n=== Scan this QR code with WhatsApp ===\n');
    qrcode.generate(qr, { small: true });
    console.log('Open WhatsApp > Settings > Linked Devices > Link a Device\n');
});

// Connected
client.on('ready', async () => {
    reconnectAttempts = 0;
    console.log('\n[Bot] Connected to WhatsApp!');

    if (TARGET_GROUPS.length === 0) {
        console.log('\n[Bot] No TARGET_GROUPS configured. Listing groups:\n');
        const chats = await client.getChats();
        chats.filter(c => c.isGroup).forEach(g => {
            console.log(`  ${g.name}`);
            console.log(`    ID: ${g.id._serialized}\n`);
        });
        console.log('Add group IDs to TARGET_GROUPS in .env\n');
    } else {
        console.log(`[Bot] Monitoring ${TARGET_GROUPS.length} group(s)`);
    }

    const stats = await getStats();
    console.log(`[Bot] DB: ${stats.total} requests (${stats.open} open, ${stats.matched} matched)\n`);
});

// Message handler
client.on('message', async (msg) => {
    try {
        if (processedMessages.has(msg.id._serialized)) return;
        processedMessages.add(msg.id._serialized);

        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const groupId = chat.id._serialized;
        if (TARGET_GROUPS.length > 0 && !TARGET_GROUPS.includes(groupId)) return;

        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.name || 'Unknown';
        const senderNumber = msg.author || msg.from;
        const body = msg.body;

        if (!body || body.length < 3) return;

        console.log(`\n[${chat.name}] ${senderName}: ${body.substring(0, 60)}${body.length > 60 ? '...' : ''}`);

        // Parse with LLM
        const parsed = await parseMessage(body, senderName);

        // Log every message
        await logMessage({
            sourceGroup: chat.name,
            sourceContact: senderNumber,
            senderName,
            messageText: body,
            isRequest: parsed.isRequest || false,
            parsedData: parsed,
            error: parsed._error || null
        });

        if (!parsed.isRequest) {
            console.log('[Bot] Not a request');
            return;
        }

        // Save to database
        const request = await saveRequest({
            source: 'whatsapp',
            sourceGroup: chat.name,
            sourceContact: senderNumber,
            type: parsed.type,
            category: parsed.category,
            date: parsed.date,
            origin: parsed.origin,
            destination: parsed.destination,
            details: parsed.details || {},
            rawMessage: body
        });

        if (!request) {
            console.log('[Bot] Failed to save');
            return;
        }

        // Find matches
        const matches = await processRequest(request);

        if (matches.length > 0) {
            console.log(`[Bot] ${matches.length} match(es)!`);
            matches.forEach(m => console.log('\n' + formatMatch(m)));
        }

    } catch (error) {
        console.error('[Bot] Error:', error.message);
    }
});

// Auto-reconnect
client.on('disconnected', async (reason) => {
    console.log(`\n[Bot] Disconnected: ${reason}`);

    if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = Math.min(reconnectAttempts * 10, 60);
        console.log(`[Bot] Reconnecting in ${delay}s (attempt ${reconnectAttempts}/${MAX_RECONNECT})...`);
        setTimeout(() => {
            client.destroy().then(() => {
                client = createClient();
                bindEvents();
                client.initialize();
            });
        }, delay * 1000);
    } else {
        console.error('[Bot] Max reconnect attempts reached. Exiting.');
        process.exit(1);
    }
});

client.on('auth_failure', (msg) => {
    console.error('[Bot] Auth failed:', msg);
    console.log('[Bot] Delete .wwebjs_auth folder and restart to re-scan QR.');
    process.exit(1);
});

// Cleanup old message IDs periodically
setInterval(() => {
    if (processedMessages.size > 10000) processedMessages.clear();
}, 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Bot] Shutting down...');
    await client.destroy();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('[Bot] Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('[Bot] Unhandled rejection:', err.message || err);
});

// Start
console.log('\n=== Aggie Connect Bot ===\n');
console.log('Initializing...\n');
client.initialize();
