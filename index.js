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
const https = require("https"); // تم إضافة مكتبة التنبيه

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
const tempCodes = new Map();
const myNumber = "966554526287@s.whatsapp.net";

// --- 1. إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// --- 2. وظيفة نبض القلب (Keep-Alive) لمنع Render من النوم ---
// يقوم السيرفر بمناداة نفسه كل 5 دقائق ليبقى مستيقظاً
setInterval(() => {
    const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ping`;
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(url, (res) => {
            console.log("💓 نبض القلب: السيرفر مستيقظ");
        }).on('error', (e) => {
            console.log("⚠️ فشل النبض: " + e.message);
        });
    }
}, 5 * 60 * 1000); // 5 دقائق

function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    return clean + "@s.whatsapp.net";
}

async function startBot() {
    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    try {
        const sessionSnap = await db.collection('session').doc('creds_v2').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
            console.log("📂 تم استعادة الجلسة سحابياً.");
        }
    } catch (e) { }

    const { state, saveCreds } = await useMultiFileAuthState(folder);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["نجم الإبداع", "Chrome", "1.0"]
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try {
            await db.collection('session').doc('creds_v2').set(state.creds, { merge: true });
        } catch (e) { }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (sender !== myNumber) return;

        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            let count = 0;
            usersSnap.forEach(async (doc) => {
                const user = doc.data();
                await sock.sendMessage(normalizePhone(user.phone), { 
                    text: `📢 تطبيق جديد من نجم الإبداع!\n🚀 حمله الآن: ${link}` 
                });
                count++;
            });
            await sock.sendMessage(myNumber, { text: `✅ بدأت عملية النشر لـ ${count} مستخدم.` });
        }

        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            await sock.sendMessage(myNumber, { text: `📊 إجمالي المستخدمين: ${usersSnap.size}` });
        }

        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let list = "👥 قائمة المستخدمين:\n";
            usersSnap.forEach(doc => {
                const u = doc.data();
                list += `👤 ${u.name} - 📞 ${u.phone} (${u.app || 'عام'})\n`;
            });
            await sock.sendMessage(myNumber, { text: list });
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 النظام جاهز!");
        }
        if (connection === 'close') startBot();
    });
}

app.get("/ping", (req, res) => res.send("pong"));

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);
    try {
        await db.collection('users').doc(phone).set({ 
            name, phone, app: appName || "عام", date: new Date() 
        }, { merge: true });
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 أهلاً يا ${name}، كودك هو: *${otp}*` });
        await sock.sendMessage(myNumber, { text: `🆕 مستخدم جديد: ${name} (${phone})` });
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

app.get("/", (req, res) => {
    if (qrImage === "DONE") res.send("<h1 style='color:green;'>✅ Connected</h1>");
    else res.send(qrImage ? `<img src="${qrImage}">` : "Loading...");
});

app.listen(process.env.PORT || 10000, () => startBot());
