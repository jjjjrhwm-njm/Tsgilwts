const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
const tempCodes = new Map(); // لحفظ الأكواد مؤقتاً للتحقق

// إعداد Firebase لاستعادة الجلسة (QR) تلقائياً
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function startBot() {
    // 1. استعادة الجلسة من Firebase ليتصل البوت فوراً بدون تصوير كود
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    try {
        const doc = await db.collection('session').doc('session_vip_rashed').get();
        if (doc.exists) {
            fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
            console.log("✅ تم سحب جلسة الاتصال من Firebase بنجاح.");
        }
    } catch (e) { console.log("⚠️ تعذر سحب الجلسة، قد يطلب كود QR."); }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log("🚀 البوت متصل الآن وجاهز لاستقبال طلبات التطبيق.");
        }
    });
}

// --- مسارات الـ API التي سيتصل بها تطبيقك ---

// 1. طلب كود (يرسل رسالة للمستخدم)
app.post("/request-otp", async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "الرقم مطلوب" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);

    try {
        const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
        await sock.sendMessage(jid, { 
            text: `*🔐 كود التحقق الخاص بك هو:* \n\n *${otp}* \n\n يرجى إدخال هذا الكود في التطبيق لتفعيل حسابك.` 
        });
        res.status(200).json({ success: true, message: "تم إرسال الكود" });
    } catch (e) {
        res.status(500).json({ success: false, error: "فشل الإرسال" });
    }
});

// 2. التحقق من الكود (يتأكد إذا كان الكود المدخل صح)
app.post("/verify-otp", (req, res) => {
    const { phone, code } = req.body;
    if (tempCodes.has(phone) && tempCodes.get(phone) === code) {
        tempCodes.delete(phone); // حذف الكود بعد الاستخدام للأمان
        return res.status(200).json({ success: true, message: "الكود صحيح" });
    }
    res.status(401).json({ success: false, message: "الكود خاطئ" });
});

app.listen(process.env.PORT || 10000, () => {
    console.log(`📡 نظام التحقق يعمل على المنفذ ${process.env.PORT || 10000}`);
    startBot();
});
