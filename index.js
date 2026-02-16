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
const myNumber = "966554526287@s.whatsapp.net"; // رقمك للتحكم

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

// --- 2. نبض القلب لمنع Render من النوم ---
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

    // --- استعادة الهوية من session_otp_stable ---
    try {
        const sessionSnap = await db.collection('session').doc('session_otp_stable').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
            console.log("📂 تم استعادة الهوية بنجاح.");
        }
    } catch (e) { console.log("⚠️ فشل استعادة الجلسة."); }

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["CreativeStar", "Chrome", "1.0"],
        syncFullHistory: false,
        generateHighQualityQR: true
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try {
            // حفظ الهوية المحدثة في Firebase
            await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true });
        } catch (e) { console.log("❌ خطأ حفظ Firebase"); }
    });

    // --- نظام الأوامر (نجم نشر، نجم احصا، نجم حضر) ---
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
            await sock.sendMessage(myNumber, { text: `✅ تم النشر لـ ${count} مستخدم.` });
        }

        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            await sock.sendMessage(myNumber, { text: `📊 إجمالي المستخدمين: ${usersSnap.size}` });
        }

        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let list = "👥 قائمة المستخدمين المسجلين:\n";
            usersSnap.forEach(doc => {
                const u = doc.data();
                list += `👤 ${u.name} - 📞 ${u.phone} (${u.app || 'عام'})\n`;
            });
            await sock.sendMessage(myNumber, { text: list });
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 البوت متصل بالهوية المستقرة!");

            // إرسال رسالة تفعيل لمرة واحدة فقط
            try {
                const statusRef = db.collection('status').doc('activation');
                const statusSnap = await statusRef.get();
                if (!statusSnap.exists || !statusSnap.data().notified) {
                    await sock.sendMessage(myNumber, { text: "✅ تم تشغيل نظام نجم الإبداع المطور بنجاح!" });
                    await statusRef.set({ notified: true });
                }
            } catch (e) {}
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });
}

// الممرات (Routes)
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName } = req.query;
    if (!phone || !name) return res.status(400).send("Missing Data");

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);

    try {
        // حفظ المستخدم للأبد في Firebase
        await db.collection('users').doc(phone).set({ 
            name, phone, app: appName || "عام", date: new Date() 
        }, { merge: true });

        await sock.sendMessage(normalizePhone(phone), { text: `🔐 أهلاً يا ${name}، كودك هو: *${otp}*` });
        
        // إخطارك فوراً بالعضو الجديد
        await sock.sendMessage(myNumber, { 
            text: `🆕 مستخدم جديد!\n👤 الاسم: ${name}\n📞 الرقم: ${phone}\n📱 التطبيق: ${appName || "عام"}` 
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

app.get("/", (req, res) => {
    if (qrImage === "DONE") res.send("<h1 style='color:green;text-align:center;'>✅ النظام متصل ومستقر</h1>");
    else res.send(qrImage ? `<center><img src="${qrImage}"><h3>امسح الكود لتفعيل الهوية</h3></center>` : "جاري التحميل...");
});

app.listen(process.env.PORT || 10000, () => startBot());
