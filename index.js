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
const myNumber = "966554526287"; // رقمك بدون إضافات

// إعداد Firebase
const firebaseConfig = process.env.FIREBASE_CONFIG;
const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// نبض القلب
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ping`);
    }
}, 5 * 60 * 1000);

function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
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

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["CreativeStar", "Chrome", "1.0"]
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try {
            await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true });
        } catch (e) {}
    });

    // --- نظام الأوامر المطور (تم إصلاح التحقق من الرقم) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        // تنظيف رقم المرسل لضمان عمل الأوامر
        const sender = msg.key.remoteJid.split('@')[0].split(':')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (sender !== myNumber) return;

        // 1. نجم نشر [الرابط]
        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            usersSnap.forEach(async (doc) => {
                await sock.sendMessage(normalizePhone(doc.data().phone), { text: `📢 تطبيق جديد!\n🚀 حمله من هنا: ${link}` });
            });
            await sock.sendMessage(msg.key.remoteJid, { text: "✅ جاري النشر للجميع..." });
        }

        // 2. نجم احصا
        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            await sock.sendMessage(msg.key.remoteJid, { text: `📊 عدد المستخدمين المسجلين: ${usersSnap.size}` });
        }

        // 3. نجم حضر
        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            let list = "📱 تطبيقاتك المبرمجة:\n";
            apps.forEach((name, i) => list += `${i + 1} - ${name}\n`);
            await sock.sendMessage(msg.key.remoteJid, { text: list + "\n💡 أرسل الرقم لعرض المستخدمين." });
        }

        // عرض مستخدمي تطبيق معين (مثلاً 1 أو 2)
        if (/^\d+$/.test(text) && text.length < 3) {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            const selected = apps[parseInt(text) - 1];
            if (selected) {
                let userList = `👥 مستخدمي [${selected}]:\n`;
                usersSnap.docs.filter(d => d.data().appName === selected).forEach(d => {
                    userList += `👤 ${d.data().name} (${d.data().phone})\n`;
                });
                await sock.sendMessage(msg.key.remoteJid, { text: userList });
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') qrImage = "DONE";
        if (connection === 'close') startBot();
    });
}

// ممر فحص بصمة الجهاز (منع إعادة التسجيل عند مسح البيانات)
app.get("/check-device", async (req, res) => {
    const deviceId = req.query.id;
    const userSnap = await db.collection('users').where("deviceId", "==", deviceId).get();
    if (!userSnap.empty) res.status(200).send("SUCCESS");
    else res.status(404).send("NOT_FOUND");
});

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);
    try {
        // حفظ البيانات مع بصمة الجهاز
        await db.collection('users').doc(phone).set({ name, phone, appName, deviceId, date: new Date() }, { merge: true });
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 يا ${name}، كودك هو: *${otp}*` });
        await sock.sendMessage(normalizePhone(myNumber), { text: `🆕 مستخدم جديد في ${appName}!\n👤 ${name} (${phone})` });
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.get("/verify-otp", (req, res) => {
    const { phone, code } = req.query;
    if (tempCodes.get(phone) === code) {
        tempCodes.delete(phone);
        res.status(200).send("SUCCESS");
    } else res.status(401).send("FAIL");
});

app.get("/ping", (req, res) => res.send("pong"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
