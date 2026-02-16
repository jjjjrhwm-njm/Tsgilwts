const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    Browsers // أضفنا هذا لجلب تعريفات المتصفح القياسية
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
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر ${res.statusCode}`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال"); }
}

function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    else if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) clean = '967' + clean;
    return clean + "@s.whatsapp.net";
}

// --- 3. محرك معالجة الأوامر ---
async function processCommand(jid, text, sender, isMe) {
    const botTokens = ["أرسل", "تم استلام", "✅", "❌", "🎯"];
    if (isMe && botTokens.some(token => text.includes(token))) return true;
    if (sender !== myNumber && !isMe) return false;

    const currentState = userState.get(jid);
    if (currentState) {
        if (text.toLowerCase() === "خروج") {
            userState.delete(jid);
            await safeSend(jid, { text: "❌ تم إلغاء العملية." });
            return true;
        }
        // ... (بقية منطق النشر الخاص بك كما هو)
    }

    if (!text.startsWith("نجم")) return false;
    // ... (بقية الأوامر كما هي)
    return true;
}

async function startBot() {
    if (isStarting) return;
    isStarting = true;

    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    
    try {
        const sessionSnap = await db.collection('session').doc('session_otp_stable').get();
        if (sessionSnap.exists) fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
    } catch (e) {}
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        // التعديل هنا: محاكاة متصفح ماك كأنه واتساب ويب حقيقي
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false,
        connectTimeoutMs: 60000, 
        keepAliveIntervalMs: 30000,
        printQRInTerminal: true // لكي تراه في سجلات رندر أيضاً للتأكد
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // حفظ الجلسة في Firebase تلقائياً عند التحديث
        try {
            const creds = JSON.parse(fs.readFileSync(`${folder}/creds.json`));
            await db.collection('session').doc('session_otp_stable').set(creds);
        } catch (e) {}
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            console.log("🆕 QR Code جديد تم توليده.");
            qrImage = await QRCode.toDataURL(qr);
        }

        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 النظام متصل.");
            setTimeout(() => {
                safeSend(normalizePhone(myNumber), { text: "🌟 *نجم الإبداع جاهز للعمل!*" });
            }, 2000);
        }

        if (connection === 'close') {
            isStarting = false;
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) {
                console.log("🔄 إعادة الاتصال...");
                setTimeout(() => startBot(), 5000);
            } else {
                console.log("❌ تم تسجيل الخروج. يرجى مسح ملفات الـ Auth.");
                qrImage = "";
                if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true });
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        const now = Math.floor(Date.now() / 1000);
        if (now - msg.messageTimestamp > 15) return;

        const jid = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const sender = jid.split('@')[0].split(':')[0];
        const isMe = msg.key.fromMe;

        await processCommand(jid, text, sender, isMe);
    });
}

// --- ممرات الـ API ---
app.get("/", (req, res) => {
    if (qrImage === "DONE") {
        res.send("<h1>✅ المتصفح متصل بنجاح!</h1>");
    } else if (qrImage) {
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#f0f2f5; font-family:sans-serif;">
                    <h2>امسح الكود لتشغيل نجم الإبداع</h2>
                    <img src="${qrImage}" style="border: 10px solid white; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
                    <p>سيتم تحديث الصفحة تلقائياً عند الاتصال</p>
                    <script>
                        setInterval(() => {
                            fetch('/').then(r => r.text()).then(html => {
                                if(html.includes('✅')) location.reload();
                            });
                        }, 5000);
                    </script>
                </body>
            </html>
        `);
    } else {
        res.send("<h1>⏳ جاري تجهيز الكود... انتظر ثواني وأعد تحميل الصفحة</h1>");
    }
});

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, { otp, name, appName, deviceId });
    try {
        await safeSend(normalizePhone(phone), { text: `🔐 أهلاً ${name}، كود دخولك لـ [${appName}] هو: *${otp}*` });
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    const data = tempCodes.get(phone);
    if (data && data.otp === code) {
        await db.collection('users').doc(phone).set({ 
            name: data.name, phone, appName: data.appName, deviceId: data.deviceId, date: new Date() 
        }, { merge: true });
        tempCodes.delete(phone);
        await safeSend(normalizePhone(myNumber), { text: `🆕 مستخدم جديد: ${data.name} (${phone})` });
        res.status(200).send("SUCCESS");
    } else res.status(401).send("FAIL");
});

app.get("/ping", (req, res) => res.send("💓"));
app.listen(process.env.PORT || 10000, () => startBot());
