require("dotenv").config();
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    delay 
} = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
const tempCodes = new Map();

// --- إعداد Firebase لاستعادة الجلسة بنفس الهوية السابقة ---
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

async function startBot() {
    // 1. استعادة جلسة "session_vip_rashed" لضمان تخطي الـ QR
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    try {
        const doc = await db.collection('session').doc('session_vip_rashed').get();
        if (doc.exists) {
            fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
            console.log("✅ تم سحب الهوية (Session) من Firebase بنجاح.");
        }
    } catch (e) { 
        console.log("⚠️ تعذر استعادة الجلسة، قد يظهر كود QR."); 
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    // 2. تطبيق نفس إعدادات الهوية (Browser & Sync) من كودك القديم
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
        browser: ["Mac OS", "Chrome", "114.0.5735.198"], // نفس بصمة المتصفح السابقة
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    // حفظ التحديثات في Firebase تلقائياً لضمان استمرار الاتصال
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json', 'utf8'));
        await db.collection('session').doc('session_vip_rashed').set(creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log("🚀 تم الاتصال بنجاح! نظام الـ OTP جاهز للعمل بنفس هوية 'راشد'.");
        }
    });
}

// --- مسارات الـ API للربط مع التطبيق ---

// طلب الكود (يرسل رسالة للمستخدم)
app.post("/request-otp", async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: "الرقم مطلوب" });

    // توليد كود من 6 أرقام
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);

    try {
        const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
        
        // محاكاة بشرية بسيطة قبل الإرسال (اختياري لزيادة الأمان)
        await sock.sendPresenceUpdate('composing', jid);
        await delay(1500);

        await sock.sendMessage(jid, { 
            text: `*🔐 كود التحقق الخاص بك هو:* \n\n *${otp}* \n\n يرجى إدخال هذا الكود في التطبيق لتفعيل حسابك.` 
        });

        res.status(200).json({ success: true, message: "تم إرسال الكود بنجاح" });
    } catch (e) {
        console.error("خطأ في الإرسال:", e);
        res.status(500).json({ success: false, error: "فشل في إرسال الكود" });
    }
});

// التحقق من الكود المدخل من قبل المستخدم
app.post("/verify-otp", (req, res) => {
    const { phone, code } = req.body;
    
    if (tempCodes.has(phone) && tempCodes.get(phone) === code) {
        tempCodes.delete(phone); // مسح الكود بعد التحقق للأمان
        return res.status(200).json({ success: true, message: "تم التحقق بنجاح" });
    }
    
    res.status(401).json({ success: false, message: "الكود المدخل غير صحيح" });
});

// تشغيل السيرفر
app.listen(process.env.PORT || 10000, () => {
    console.log(`📡 نظام OTP يعمل على المنفذ: ${process.env.PORT || 10000}`);
    startBot();
});
