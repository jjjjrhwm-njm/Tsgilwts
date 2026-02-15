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

// نبض القلب لمنع Render من النوم
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ping`);
    }
}, 5 * 60 * 1000);

// تصحيح الأرقام عالمياً
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, '');
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0') && clean.length > 5) clean = clean.substring(1);
    // إذا كان الرقم ناقصاً (مثل 55xxx) افترض أنه سعودي
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    return clean + "@s.whatsapp.net";
}

async function startBot() {
    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    // استعادة الجلسة من Firebase
    try {
        const sessionSnap = await db.collection('session').doc('session_otp_stable').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
            console.log("📂 تم استعادة الجلسة بنجاح.");
        }
    } catch (e) { console.log("⚠️ فشل استعادة الجلسة."); }

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "121.0.6167.160"],
        syncFullHistory: false,
        generateHighQualityQR: true
    });

    // إصلاح خطأ الحفظ (تجنب القراءة المباشرة من الملف لتفادي SyntaxError)
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try {
            await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true });
        } catch (e) { console.log("❌ خطأ حفظ Firebase"); }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 البوت مرتبط وجاهز!");
            
            // إرسال رسالة تأكيد لرقمك فور التفعيل
            const myNumber = normalizePhone("0554526287");
            await sock.sendMessage(myNumber, { text: "✅ تم تفعيل بوت نجم الإبداع بنجاح على سيرفر Render!" });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });
}

// الواجهات والممرات
app.get("/", (req, res) => {
    if (qrImage === "DONE") res.send("<h1 style='text-align:center;color:green;'>✅ مرتبط وجاهز</h1>");
    else if (qrImage) res.send(`<center><img src="${qrImage}"><h3>امسح الكود</h3></center>`);
    else res.send("<center><h3>جاري التحميل...</h3></center>");
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/request-otp", async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).send("No Phone");
    const jid = normalizePhone(phone);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);
    try {
        await sock.sendMessage(jid, { text: `🔐 كود تحقق تطبيقك هو: *${otp}*` });
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

app.listen(process.env.PORT || 10000, () => startBot());
