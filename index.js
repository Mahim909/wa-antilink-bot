const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const LINKS_FILE = './allowed_links.json';
const SUBS_FILE = './subscriptions.json';

// Load Allowed Links
let allowedLinks = ['tiktok.com'];
if (fs.existsSync(LINKS_FILE)) {
    allowedLinks = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf-8'));
} else {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(allowedLinks, null, 2));
}

function saveLinks() {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(allowedLinks, null, 2));
}

// Load Subscriptions
let subscriptions = {};
if (fs.existsSync(SUBS_FILE)) {
    subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'));
} else {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
}

function saveSubs() {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('✅ Silent Anti-Link & Subscription Bot is LIVE!');
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const chatGroup = m.key.remoteJid;
        const messageSender = m.key.participant || chatGroup;

        if (chatGroup.endsWith('@g.us')) {
            const messageText = m.message.conversation || 
                                m.message.extendedTextMessage?.text || 
                                m.message.imageMessage?.caption || 
                                m.message.videoMessage?.caption || '';

            // --- 1. SUBSCRIPTION & EXPIRY CHECK ---
            const currentTime = Date.now();
            const groupSub = subscriptions[chatGroup];

            // If group has no subscription or expiry date has passed
            const isExpired = !groupSub || currentTime > groupSub.expiryDate;

            // --- 2. ADMIN & OWNER COMMANDS ---
            // Command to add subscription: .addsub days (e.g., .addsub 30 for 30 days)
            if (messageText.startsWith('.addsub ')) {
                const args = messageText.replace('.addsub ', '').trim();
                const days = parseInt(args);

                if (!isNaN(days)) {
                    const expiryTime = currentTime + (days * 24 * 60 * 60 * 1000);
                    subscriptions[chatGroup] = {
                        expiryDate: expiryTime,
                        planDays: days
                    };
                    saveSubs();
                    await sock.sendMessage(chatGroup, { text: `✅ Subscription activated for ${days} days in this group!` });
                } else {
                    await sock.sendMessage(chatGroup, { text: `⚠️ Please provide valid days! Example: .addsub 30` });
                }
                return;
            }

            if (messageText === '.checksub') {
                if (isExpired) {
                    await sock.sendMessage(chatGroup, { text: `❌ Subscription is EXPIRED or not active!` });
                } else {
                    const remainingDays = Math.ceil((groupSub.expiryDate - currentTime) / (1000 * 60 * 60 * 24));
                    await sock.sendMessage(chatGroup, { text: `✅ Subscription is Active! Remaining: ${remainingDays} days.` });
                }
                return;
            }

            // If subscription is expired, do not process anti-link
            if (isExpired) {
                return; 
            }

            // --- 3. LINK MANAGEMENT COMMANDS ---
            if (messageText.startsWith('.addlink ')) {
                const newLink = messageText.replace('.addlink ', '').trim().toLowerCase();
                if (!allowedLinks.includes(newLink)) {
                    allowedLinks.push(newLink);
                    saveLinks();
                    await sock.sendMessage(chatGroup, { text: `✅ *${newLink}* added to allowed list!` });
                }
                return;
            }

            if (messageText.startsWith('.dellink ')) {
                const removeLink = messageText.replace('.dellink ', '').trim().toLowerCase();
                if (allowedLinks.includes(removeLink)) {
                    allowedLinks = allowedLinks.filter(l => l !== removeLink);
                    saveLinks();
                    await sock.sendMessage(chatGroup, { text: `🗑️ *${removeLink}* removed from allowed list!` });
                }
                return;
            }

            if (messageText === '.listlink') {
                const list = allowedLinks.map((l, i) => `${i + 1}. ${l}`).join('\n');
                await sock.sendMessage(chatGroup, { text: `📋 *Allowed Links List:*\n\n${list}` });
                return;
            }

            // --- 4. SILENT LINK DELETE LOGIC ---
            const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/gi;

            if (linkRegex.test(messageText)) {
                const isAllowed = allowedLinks.some(link => messageText.toLowerCase().includes(link));

                if (!isAllowed) {
                    try {
                        await sock.sendMessage(chatGroup, { delete: m.key });
                    } catch (error) {
                        console.log('Delete failed. Make sure the bot is an Admin!');
                    }
                }
            }
        }
    });
}

startBot();
