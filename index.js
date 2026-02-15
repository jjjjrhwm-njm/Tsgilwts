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

// --- 1. إعداد Firebase (استعادة الجلسة) ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// --- 2. دالة النبض (Keep-Alive) لمنع Render من النوم ---
setInterval(() => {
    const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ping`;
    https.get(url, (res) => {
        console.log("💓 نبض القلب: السيرفر مستيقظ");
    }).on('error', (e) => {
        console.log("⚠️ فشل النبض: " + e.message);
    });
}, 10 * 60 * 1000); // تنبيه كل 10 دقائق

// --- 3. تصحيح الأرقام عالمياً (Global Normalization) ---
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); // إزالة كل شيء عدا الأرقام
    
    // إزالة الأصفار الدولية الزائدة
    if (clean.startsWith('00')) clean = clean.substring(2);
    
    // إذا بدأ بصفر واحد (رقم محلي)، يفترض أنه يحتاج مفتاح دولة
    // ملاحظة: البوت سيعمل بشكل أفضل إذا أدخل المستخدم مفتاح الدولة مباشرة
    if (clean.startsWith('0') && clean.length > 5) {
        clean = clean.substring(1);
    }
    
    return clean + "@s.whatsapp.net";
}

async function startBot() {
    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    // استعادة الجلسة من الذاكرة السحابية
    try {
        const sessionSnap = await db.collection('session').doc('session_otp_stable').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
            console.log("📂 تم استعادة الجلسة بنجاح.");
        }
    } catch (e) { console.log("⚠️ تعذر جلب الجلسة."); }

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "121.0.6167.160"],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        generateHighQualityQR: true
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync(`${folder}/creds.json`, 'utf8'));
        await db.collection('session').doc('session_otp_stable').set(creds, { merge: true });
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 البوت مرتبط وجاهز!");
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });
}

// واجهة السيرفر
app.get("/", (req, res) => {
    if (qrImage === "DONE") res.send("<h1 style='text-align:center;color:green;'>✅ مرتبط</h1>");
    else if (qrImage) res.send(`<center><img src="${qrImage}"><h3>امسح الكود مرة واحدة فقط</h3></center>`);
    else res.send("<center><h3>جاري التحميل...</h3></center>");
});

app.get("/ping", (req, res) => res.send("pong"));

// --- 4. طلب الكود (GET) - متوافق مع سمالي ---
app.get("/request-otp", async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).send("Missing Phone");

    const jid = normalizePhone(phone);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);

    try {
        await sock.sendMessage(jid, { text: `🔐 كود تحقق تطبيقك هو: *${otp}*` });
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// --- 5. التحقق من الكود (GET) ---
app.get("/verify-otp", (req, res) => {
    const { phone, code } = req.query;
    if (tempCodes.get(phone) === code) {
        tempCodes.delete(phone);
        res.status(200).send("SUCCESS");
    } else {
        res.status(401).send("FAIL");
    }
});

app.listen(process.env.PORT || 10000, () => startBot());
