const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    delay 
} = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
const tempCodes = new Map(); // يحفظ { "رقم_الهاتف:اسم_التطبيق": "الكود" }

// إعداد Firebase لاستعادة الجلسة
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
    if (!fs.existsSync('./auth_info_otp')) fs.mkdirSync('./auth_info_otp');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_otp');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Mac OS", "Safari", "17.0"], // هوية المتصفح الجديدة
        syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync('./auth_info_otp/creds.json', 'utf8'));
        await db.collection('session').doc('session_otp_multi').set(creds, { merge: true });
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 البوت متصل وجاهز لخدمة تطبيقاتك.");
        }
    });
}

// واجهة عرض الكود
app.get("/", (req, res) => {
    if (qrImage === "DONE") res.send("<h1 style='text-align:center;color:green;margin-top:50px;'>✅ البوت متصل وجاهز</h1>");
    else if (qrImage) res.send(`<div style='text-align:center;margin-top:50px;'><img src="${qrImage}"><h1>امسح الكود لتفعيل نظام OTP</h1></div>`);
    else res.send("<h1 style='text-align:center;margin-top:50px;'>🔄 جاري التوليد...</h1>");
});

// --- مسار طلب الكود (يتزامن مع التطبيق) ---
app.post("/request-otp", async (req, res) => {
    const { phone, appName } = req.body; // نستقبل الرقم واسم التطبيق
    if (!phone || !appName) return res.status(400).json({ success: false });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const key = `${phone}:${appName}`;
    tempCodes.set(key, otp);

    try {
        const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
        await sock.sendMessage(jid, { 
            text: `*🔐 كود التحقق لتطبيق (${appName}):*\n\nكودك هو: *${otp}*\n\nلا تشارك هذا الكود مع أحد يا مطور.` 
        });
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- مسار التحقق ---
app.post("/verify-otp", (req, res) => {
    const { phone, appName, code } = req.body;
    const key = `${phone}:${appName}`;
    if (tempCodes.get(key) === code) {
        tempCodes.delete(key);
        res.status(200).json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

app.listen(process.env.PORT || 10000, () => startBot());
