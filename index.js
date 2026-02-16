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
const myNumber = "966554526287"; // رقمك للتحكم بدون إضافات

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

// --- 2. نبض القلب (Keep-Alive) ---
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

    // --- نظام الأوامر المطور (نجم نشر، نجم احصا، نجم حضر) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const sender = msg.key.remoteJid.split('@')[0].split(':')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (sender !== myNumber) return;

        // 1. نجم نشر [الرابط]
        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            usersSnap.forEach(async (doc) => {
                await sock.sendMessage(normalizePhone(doc.data().phone), { 
                    text: `📢 تطبيق جديد من نجم الإبداع!\n🚀 حمله من هنا: ${link}` 
                });
            });
            await sock.sendMessage(msg.key.remoteJid, { text: "✅ جاري النشر لجميع المشتركين..." });
        }

        // 2. نجم احصا
        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            await sock.sendMessage(msg.key.remoteJid, { text: `📊 إحصائياتك:\n👥 إجمالي المستخدمين: ${usersSnap.size}` });
        }

        // 3. نجم حضر (قائمة التطبيقات)
        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            let list = "📱 تطبيقاتك المبرمجة:\n";
            apps.forEach((name, i) => list += `${i + 1} - تطبيق ${name}\n`);
            await sock.sendMessage(msg.key.remoteJid, { text: list + "\n💡 أرسل رقم التطبيق لعرض مستخدميه." });
        }

        // فرز المستخدمين حسب الرقم (1، 2، إلخ)
        if (/^\d+$/.test(text) && text.length < 3) {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            const selected = apps[parseInt(text) - 1];
            if (selected) {
                let userList = `👥 مستخدمي [${selected}]:\n`;
                usersSnap.docs.filter(d => (d.data().appName || "عام") === selected).forEach(d => {
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

// ممر فحص الجهاز (للدخول التلقائي)
app.get("/check-device", async (req, res) => {
    const { id } = req.query;
    const userSnap = await db.collection('users').where("deviceId", "==", id).get();
    if (!userSnap.empty) res.status(200).send("SUCCESS");
    else res.status(404).send("NOT_FOUND");
});

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);
    try {
        await db.collection('users').doc(phone).set({ 
            name, phone, appName: appName || "عام", deviceId, date: new Date() 
        }, { merge: true });
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 يا ${name}، كود تحقق تطبيقك هو: *${otp}*` });
        await sock.sendMessage(normalizePhone(myNumber), { 
            text: `🆕 عضو جديد!\n👤 الاسم: ${name}\n📞 الرقم: ${phone}\n📱 التطبيق: ${appName}` 
        });
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
