/**
 * Aggie Connect - WhatsApp Bot
 * Listens to group messages, parses with LLM, stores in Supabase, finds matches
 *
 * Group monitoring is managed via the monitored_groups table in Supabase.
 * Toggle groups active/inactive in the Table Editor - the bot picks up
 * changes within 60 seconds, no restart needed.
 */

require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { parseMessage } = require('./parser');
const { saveRequest, logMessage, getStats, loadMonitoredGroups, getGroupUpdates, seedGroups } = require('./db');
const { processRequest, formatMatch } = require('./matcher');

const monitoredGroupIds = new Set();
let lastGroupCheck = new Date();
const GROUP_POLL_INTERVAL = 60 * 1000;

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

async function refreshMonitoredGroups() {
    const groups = await loadMonitoredGroups();
    monitoredGroupIds.clear();
    groups.forEach(g => monitoredGroupIds.add(g.group_id));
    return groups.length;
}

let client = createClient();

client.on('qr', (qr) => {
    console.log('\n=== Scan this QR code with WhatsApp ===\n');
    qrcode.generate(qr, { small: true });
    console.log('Open WhatsApp > Settings > Linked Devices > Link a Device\n');
});

client.on('ready', async () => {
    reconnectAttempts = 0;
    console.log('\n[Bot] Connected to WhatsApp!');

    // Seed all WhatsApp groups into monitored_groups table (inactive by default)
    const chats = await client.getChats();
    const waGroups = chats.filter(c => c.isGroup).map(g => ({
        id: g.id._serialized,
        name: g.name
    }));
    await seedGroups(waGroups);

    // Load active monitored groups from DB
    const count = await refreshMonitoredGroups();
    lastGroupCheck = new Date();

    console.log(`\n[Bot] Available groups (${waGroups.length}):\n`);
    waGroups.forEach(g => {
        const monitored = monitoredGroupIds.has(g.id);
        console.log(`  ${monitored ? '[monitoring] ' : ''}${g.name}`);
        console.log(`    ID: ${g.id}\n`);
    });

    if (monitoredGroupIds.size === 0) {
        console.log('[Bot] No active groups in DB - monitoring nothing. Activate groups in Supabase.\n');
    } else {
        console.log(`[Bot] Monitoring ${count} group(s) (from DB)\n`);
    }

    const stats = await getStats();
    console.log(`[Bot] DB: ${stats.total} requests (${stats.open} open, ${stats.matched} matched)\n`);
});

client.on('message', async (msg) => {
    try {
        if (processedMessages.has(msg.id._serialized)) return;
        processedMessages.add(msg.id._serialized);

        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const groupId = chat.id._serialized;
        if (monitoredGroupIds.size > 0 && !monitoredGroupIds.has(groupId)) return;

        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.name || 'Unknown';
        const senderNumber = contact.id?.user || msg.author || msg.from;
        const body = msg.body;

        if (!body || body.length < 3) return;

        console.log(`\n[${chat.name}] ${senderName}: ${body.substring(0, 60)}${body.length > 60 ? '...' : ''}`);

        const parsed = await parseMessage(body, senderName);

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
            return;
        }

        const matches = await processRequest(request);

        if (matches.length > 0) {
            console.log(`[Bot] ${matches.length} match(es)!`);
            matches.forEach(m => console.log('\n' + formatMatch(m)));
        }

    } catch (error) {
        console.error('[Bot] Error:', error.message);
    }
});

// Poll for group monitoring changes every 60s
setInterval(async () => {
    try {
        const hasChanges = await getGroupUpdates(lastGroupCheck);
        if (hasChanges) {
            const count = await refreshMonitoredGroups();
            console.log(`[Bot] Group list updated: now monitoring ${count} group(s)`);
        }
        lastGroupCheck = new Date();
    } catch (err) {
        console.error('[Bot] Group poll error:', err.message);
    }
}, GROUP_POLL_INTERVAL);

client.on('disconnected', async (reason) => {
    console.log(`\n[Bot] Disconnected: ${reason}`);

    if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = Math.min(reconnectAttempts * 10, 60);
        console.log(`[Bot] Reconnecting in ${delay}s (attempt ${reconnectAttempts}/${MAX_RECONNECT})...`);
        setTimeout(() => {
            client.destroy().then(() => {
                client = createClient();
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

setInterval(() => {
    if (processedMessages.size > 10000) processedMessages.clear();
}, 60 * 60 * 1000);

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

console.log('\n=== Aggie Connect Bot ===\n');
console.log('Initializing...\n');
client.initialize();
