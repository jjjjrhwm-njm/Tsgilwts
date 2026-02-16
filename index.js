const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
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
const myNumber = "966554526287"; 

// --- 1. إعداد Firebase (القاعدة الأساسية) ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// --- 2. نبض القلب المطور (الاستيقاظ الدائم) ---
// يعمل كل 10 دقائق لضرب ممر الـ ping الخاص بالسيرفر
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض حديدي: الحالة ${res.statusCode}`);
        }).on('error', (e) => {
            console.log("⚠️ فشل النبض ذاتياً، لا تقلق سأحاول مجدداً.");
        });
    }
}, 10 * 60 * 1000);

// --- 3. محرك تمييز الأرقام الذكي (نظام الفرز الدولي) ---
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);

    // منطق التمييز التلقائي
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    else if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) clean = '967' + clean;
    else if (clean.length === 8 && /^[34567]/.test(clean)) clean = '974' + clean;
    
    return clean + "@s.whatsapp.net";
}

async function startBot() {
    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    
    // استعادة الجلسة من Firebase لضمان بقاء الهوية
    try {
        const sessionSnap = await db.collection('session').doc('session_otp_stable').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
        }
    } catch (e) { console.log("📂 لم يتم العثور على جلسة سابقة في Firebase."); }
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try { 
            await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true }); 
        } catch (e) { console.log("❌ فشل تحديث Firebase"); }
    });

    // --- 4. محرك الأوامر (نسخة 100% استجابة) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const isMe = msg.key.fromMe; 
        const sender = jid.split('@')[0].split(':')[0];
        
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || "";

        // السماح لك بالتحكم المطلق
        if (!isMe && sender !== myNumber) return;

        console.log(`📩 استقبال أمر من ${sender}: ${text}`);

        // الأوامر شقالة 100%
        if (text === "نجم مساعدة") {
            const help = `🌟 *لوحة تحكم نجم الإبداع الحديدية:*
            
1️⃣ *نجم نشر [الرابط]* : بث تطبيق للكل.
2️⃣ *نجم احصا* : كشف المستخدمين والتطبيقات.
3️⃣ *نجم حضر* : قائمة التطبيقات الموثقة.
4️⃣ *نجم بنج* : فحص حالة السيرفر والسرعة.
5️⃣ *نجم حذف [الرقم]* : طرد رقم من النظام.
6️⃣ *نجم مسح* : تصفير الأكواد المؤقتة.`;
            await sock.sendMessage(jid, { text: help });
        }

        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            if (!link) return await sock.sendMessage(jid, { text: "⚠️ أرفق الرابط مع الأمر (نجم نشر رابطك)" });
            
            const usersSnap = await db.collection('users').get();
            let count = 0;
            for (const doc of usersSnap.docs) {
                const target = normalizePhone(doc.data().phone);
                await sock.sendMessage(target, { text: `📢 *تحديث جديد!*\n🚀 حمل تطبيقنا الآن عبر هذا الرابط:\n🔗 ${link}` });
                count++;
            }
            await sock.sendMessage(jid, { text: `✅ تم النشر بنجاح لـ ${count} مستخدم.` });
        }

        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            let msgText = `📊 *إحصائياتك الحالية:*\n\n👥 إجمالي المستخدمين: ${usersSnap.size}\n`;
            usersSnap.forEach(doc => {
                const u = doc.data();
                msgText += `\n👤 ${u.name} | 📱 ${u.appName}`;
            });
            await sock.sendMessage(jid, { text: msgText });
        }

        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            let report = "📱 *تطبيقاتك المحقونة:*";
            apps.forEach((name, i) => report += `\n${i + 1} - تطبيق: *${name}*`);
            await sock.sendMessage(jid, { text: report });
        }

        if (text.startsWith("نجم حذف")) {
            const target = text.replace("نجم حذف", "").trim();
            await db.collection('users').doc(target).delete();
            await sock.sendMessage(jid, { text: `🗑️ تم مسح الرقم ${target} من Firebase.` });
        }

        if (text === "نجم بنج") {
            const start = Date.now();
            await sock.sendMessage(jid, { text: "📡" });
            const lat = Date.now() - start;
            await sock.sendMessage(jid, { text: `🚀 السيرفر يستجيب في ${lat}ms` });
        }

        if (text === "نجم مسح") {
            tempCodes.clear();
            await sock.sendMessage(jid, { text: "🧹 تم تصفير ذاكرة الأكواد المؤقتة." });
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 النظام متصل وشغال بنسبة 100%!");
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) setTimeout(() => startBot(), 5000);
        }
    });
}

// --- ممرات الـ API (محمية ومستقرة) ---

app.get("/check-device", async (req, res) => {
    const { id, appName } = req.query;
    const userSnap = await db.collection('users').where("deviceId", "==", id).where("appName", "==", appName).get();
    if (!userSnap.empty) res.status(200).send("SUCCESS");
    else res.status(404).send("NOT_FOUND");
});

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, { otp, name, appName, deviceId });
    try {
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 أهلاً يا ${name}، كود تسجيل دخولك لتطبيق [${appName}] هو: *${otp}*` });
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    const data = tempCodes.get(phone);
    if (data && data.otp === code) {
        await db.collection('users').doc(phone).set({ 
            name: data.name, phone, appName: data.appName, deviceId: data.deviceId, date: new Date() 
        }, { merge: true });
        tempCodes.delete(phone);
        await sock.sendMessage(normalizePhone(myNumber), { text: `🆕 مستخدم سجل الآن:\n👤 ${data.name}\n📱 تطبيق: ${data.appName}` });
        res.status(200).send("SUCCESS");
    } else { res.status(401).send("FAIL"); }
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
