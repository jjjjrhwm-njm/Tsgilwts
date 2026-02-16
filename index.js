const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    Browsers 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
let isStarting = false;
const userState = new Map(); 
const myNumber = "966554526287"; 

// --- 1. إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// --- 🚨 تعريف الهوية (تغيير جذري لضمان عدم سحب ملفات قديمة) ---
const folder = './auth_android_new_system_v10'; 
const firebaseDoc = 'session_android_new_system_v10';

async function startBot() {
    if (isStarting) return;
    isStarting = true;

    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    
    // محاولة جلب الجلسة من فيرباس (فقط إذا كانت موجودة وصحيحة)
    try {
        const sessionSnap = await db.collection('session').doc(firebaseDoc).get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
        }
    } catch (e) { console.log("⚠️ لا توجد جلسة سابقة في فيرباس"); }
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        // 🚨 التعديل الأهم: تعريف أندرويد بإصدار كروم حديث (131) بدلاً من (20) القديم
        browser: ["Android", "Chrome", "131.0.6778.204"], 
        printQRInTerminal: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 تم الربط بنجاح بنظام الأندرويد الحديث!");
            // حفظ الجلسة الجديدة فوراً
            await db.collection('session').doc(firebaseDoc).set(state.creds, { merge: true });
        }
        
        if (connection === 'close') {
            isStarting = false;
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) setTimeout(() => startBot(), 10000);
        }
    });
    
    // معالج الرسائل المعتاد (كودك الشغال)
    sock.ev.on('messages.upsert', async (m) => {
        // ... (منطق الأوامر الخاص بك يبقى كما هو) ...
    });
}

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
