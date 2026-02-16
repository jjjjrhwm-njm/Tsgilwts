const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    Browsers // إضافة مكتبة المتصفحات الرسمية
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const pino = require("pino");
const https = require("https");

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
let isStarting = false;
const tempCodes = new Map(); 
const userState = new Map(); 
const myNumber = "966554526287"; 

// --- 1. إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// --- 2. النبض الحديدي ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {}).on('error', () => {});
    }
}, 10 * 60 * 1000);

async function safeSend(jid, content) {
    try {
        if (sock && sock.user) return await sock.sendMessage(jid, content);
    } catch (e) {}
}

function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    return clean + "@s.whatsapp.net";
}

// محرك الأوامر (نسختك الماسية)
async function processCommand(jid, text, sender, isMe) {
    const botTokens = ["أرسل", "تم استلام", "✅", "❌", "🎯", "🌟"];
    if (isMe && botTokens.some(token => text.includes(token))) return true;
    if (sender !== myNumber && !isMe) return false;
    // ... باقي منطق الأوامر كما هو ...
    return true;
}

async function startBot() {
    if (isStarting) return;
    isStarting = true;

    // تغيير اسم الهوية لضمان مسار جديد
    const folder = './auth_real_browser_v1'; 
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WaVersion: ${version.join('.')}, isLatest: ${isLatest}`);
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        // 🚨 التعديل الجوهري: استخدام هوية متصفح رسمية ومحدثة
        browser: Browsers.macOS('Desktop'), 
        printQRInTerminal: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            await db.collection('session').doc('session_real_browser_v1').set(state.creds, { merge: true });
            safeSend(normalizePhone(myNumber), { text: "✅ تم الربط بالبصمة الجديدة!" });
        }
        if (connection === 'close') {
            isStarting = false;
            const shouldRestart = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            if (shouldRestart) setTimeout(() => startBot(), 5000);
        }
    });

    // ... معالج الرسائل المعتاد ...
}

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
