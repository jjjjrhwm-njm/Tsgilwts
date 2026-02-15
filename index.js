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

async function startBot() {
    // إنشاء مجلد جديد للهوية الجديدة
    if (!fs.existsSync('./auth_info_new')) fs.mkdirSync('./auth_info_new');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_new');
    const { version } = await fetchLatestBaileysVersion();

    // إعدادات المتصفح الخادعة (Safari on Mac) لطلب كود QR جديد
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, // سيظهر الكود في سجلات Render
        logger: pino({ level: "silent" }),
        browser: ["Mac OS", "Safari", "17.0"], // هوية جديدة تماماً
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync('./auth_info_new/creds.json', 'utf8'));
        // حفظ في مستند جديد لعدم اختلاط الجلسات
        await db.collection('session').doc('session_otp_new').set(creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        
        if (qr) {
            console.log("⚠️ كود QR الجديد جاهز! امسحه الآن من سجلات Render.");
        }

        if (connection === 'open') {
            console.log("🚀 تم الاتصال بالهوية الجديدة! نظام OTP جاهز.");
        }
        
        if (connection === 'close') {
            console.log("🔄 جاري إعادة الاتصال...");
            startBot();
        }
    });
}

// مسارات الـ API (تبقى كما هي)
app.post("/request-otp", async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);
    try {
        const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
        await sock.sendMessage(jid, { text: `*🔐 كود التحقق:* \n\n *${otp}*` });
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(process.env.PORT || 10000, () => {
    startBot();
});
