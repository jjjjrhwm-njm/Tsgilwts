const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason 
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

// --- 2. النبض الحديدي (كل 10 دقائق) ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: ${res.statusCode}`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

async function safeSend(jid, content) {
    try {
        if (sock && sock.authState && sock.user) {
            await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ تخطي إرسال: الاتصال غير جاهز."); }
}

function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    else if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) clean = '967' + clean;
    else if (clean.length === 8 && /^[34567]/.test(clean)) clean = '974' + clean;
    return clean + "@s.whatsapp.net";
}

async function startBot() {
    if (isStarting) return;
    isStarting = true;

    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    
    try {
        const sessionSnap = await db.collection('session').doc('session_otp_stable').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
        }
    } catch (e) {}
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, auth: state, logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false, syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0, // منع انتهاء الوقت في الاستعلامات الكبيرة
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    // تحديث Firebase كل دقيقة لتقليل الضغط
    setInterval(async () => {
        if (state.creds) {
            await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true });
        }
    }, 60000);

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const messageTimestamp = msg.messageTimestamp;
            const now = Math.floor(Date.now() / 1000);
            if (now - messageTimestamp > 15) return; // تجاهل الرسائل القديمة

            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();

            if (!isMe && sender !== myNumber) return;

            const currentState = userState.get(jid);

            if (currentState && currentState.command === "نشر") {
                if (text.toLowerCase() === "خروج") {
                    userState.delete(jid);
                    return await safeSend(jid, { text: "❌ تم إلغاء العملية." });
                }
                if (currentState.step === "LINK") {
                    currentState.link = text;
                    currentState.step = "DESC";
                    userState.set(jid, currentState);
                    return await safeSend(jid, { text: "✅ تم استلام الرابط. الآن أرسل *الوصف*:" });
                }
                if (currentState.step === "DESC") {
                    currentState.desc = text;
                    currentState.step = "TARGET";
                    userState.set(jid, currentState);
                    const usersSnap = await db.collection('users').get();
                    let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
                    let menu = "🎯 الجمهور:\n\n0 - للجميع\n";
                    apps.forEach((name, i) => menu += `${i + 1} - [${name}]\n`);
                    return await safeSend(jid, { text: menu + "\n💡 أرسل رقم الخيار." });
                }
                if (currentState.step === "TARGET") {
                    const usersSnap = await db.collection('users').get();
                    let targets = (text === "0") ? usersSnap.docs : usersSnap.docs.filter(d => (d.data().appName || "عام") === [...new Set(usersSnap.docs.map(x => x.data().appName || "عام"))][parseInt(text)-1]);
                    
                    await safeSend(jid, { text: `🚀 جاري النشر لـ ${targets.length}...` });
                    for (const doc of targets) {
                        await safeSend(normalizePhone(doc.data().phone), { text: `📢 *جديد من نجم الإبداع!*\n\n${currentState.desc}\n\n🔗 ${currentState.link}` });
                    }
                    userState.delete(jid);
                    return await safeSend(jid, { text: "✅ اكتمل النشر بنجاح!" });
                }
            }

            if (text === "نجم مساعدة") {
                await safeSend(jid, { text: "🌟 *أوامر نجم:*\n1- نجم نشر\n2- نجم احصا\n3- نجم بنج\n💡 أرسل *خروج* للإلغاء." });
            }
            if (text === "نجم نشر") {
                userState.set(jid, { command: "نشر", step: "LINK" });
                await safeSend(jid, { text: "🔗 أرسل *رابط التطبيق* الآن:" });
            }
            if (text === "نجم احصا") {
                const snap = await db.collection('users').get();
                await safeSend(jid, { text: `📊 الموثقين: ${snap.size}` });
            }
        } catch (e) {}
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 النظام متصل ومستقر الآن.");
        }
        
        if (connection === 'close') {
            isStarting = false;
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            
            if (shouldReconnect) {
                console.log("🔄 إعادة تشغيل هادئة بعد 10 ثوانٍ...");
                setTimeout(() => startBot(), 10000); // زيادة وقت الانتظار لقتل النسخ القديمة
            }
        }
    });
}

app.get("/check-device", async (req, res) => {
    const { id, appName } = req.query;
    const userSnap = await db.collection('users').where("deviceId", "==", id).where("appName", "==", appName).get();
    if (!userSnap.empty) res.status(200).send("SUCCESS");
    else res.status(404).send("NOT_FOUND");
});

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, { otp, name, appName, deviceId });
    try {
        await safeSend(normalizePhone(phone), { text: `🔐 كود دخولك هو: *${otp}*` });
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
        await safeSend(normalizePhone(myNumber), { text: `🆕 موثق جديد: ${data.name}` });
        res.status(200).send("SUCCESS");
    } else { res.status(401).send("FAIL"); }
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
