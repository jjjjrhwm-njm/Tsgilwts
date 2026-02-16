const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
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
const tempCodes = new Map(); 
const myNumber = "966554526287"; 

// --- 1. إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// --- 2. نبض القلب الحديدي (كل 10 دقائق) ---
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ping`, (res) => {
            console.log("💓 نبض حديدي: السيرفر مستيقظ");
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// --- 3. محرك تمييز الأرقام الذكي (اليمن، السعودية، قطر) ---
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);

    // السعودية
    if (clean.length === 9 && clean.startsWith('5')) {
        clean = '966' + clean;
    }
    // اليمن
    else if (clean.length === 9 && (clean.startsWith('77') || clean.startsWith('73') || clean.startsWith('71') || clean.startsWith('70'))) {
        clean = '967' + clean;
    }
    // قطر
    else if (clean.length === 8 && /^[34567]/.test(clean)) {
        clean = '974' + clean;
    }
    return clean + "@s.whatsapp.net";
}

async function startBot() {
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
    sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }), browser: ["CreativeStar", "Chrome", "1.0"] });
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try { await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true }); } catch (e) {}
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid.split('@')[0].split(':')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (sender !== myNumber) return;

        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            let count = 0;
            for (const doc of usersSnap.docs) {
                await sock.sendMessage(normalizePhone(doc.data().phone), { text: `📢 تطبيق جديد!\n🚀 حمله الآن: ${link}` });
                count++;
            }
            await sock.sendMessage(msg.key.remoteJid, { text: `✅ تم النشر لـ ${count} مستخدم.` });
        }
        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            await sock.sendMessage(msg.key.remoteJid, { text: `📊 الموثقين: ${usersSnap.size}` });
        }
        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            let report = "📱 تطبيقاتك:\n";
            apps.forEach((name, i) => report += `${i + 1} - ${name}\n`);
            await sock.sendMessage(msg.key.remoteJid, { text: report });
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') qrImage = "DONE";
        if (connection === 'close') startBot();
    });
}

// ممر فحص الجهاز الخاص بكل تطبيق (Per-App)
app.get("/check-device", async (req, res) => {
    const { id, appName } = req.query;
    const userSnap = await db.collection('users')
        .where("deviceId", "==", id)
        .where("appName", "==", appName)
        .get();
    if (!userSnap.empty) res.status(200).send("SUCCESS");
    else res.status(404).send("NOT_FOUND");
});

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, { otp, name, appName, deviceId });
    try {
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 يا ${name}، كودك هو: *${otp}*` });
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
        res.status(200).send("SUCCESS");
    } else { res.status(401).send("FAIL"); }
});

app.get("/ping", (req, res) => res.send("pong"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
