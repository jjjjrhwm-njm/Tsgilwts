const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom"); // مكتبة هامة لمعالجة أخطاء الاتصال
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

// --- 2. نبض القلب الحديدي (كل 10 دقائق) ---
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ping`, (res) => {
            // نبض صامت للحفاظ على السيرفر
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// --- 3. محرك تمييز الأرقام الذكي ---
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);

    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    else if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) clean = '967' + clean;
    else if (clean.length === 8 && /^[34567]/.test(clean)) clean = '974' + clean;
    
    return clean + "@s.whatsapp.net";
}

async function startBot() {
    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    try {
        const sessionSnap = await db.collection('session').doc('session_otp_stable').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
        }
    } catch (e) {}
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();
    
    // إعداد الاتصال مع تقليل سجلات Pino لمنع الازدحام
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try { await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true }); } catch (e) {}
    });

    // --- 4. محرك الأوامر الحديدي (منقح) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        
        const jid = msg.key.remoteJid;
        const sender = jid.split('@')[0].split(':')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // السماح لك بالتحكم حتى لو أرسلت لنفسك
        if (sender !== myNumber) return;

        if (text === "نجم مساعدة") {
            const help = `🌟 *قائمة أوامر نجم الإبداع للتحكم:*
            
1️⃣ *نجم نشر [الرابط]* : نشر تطبيق لكل المشتركين.
2️⃣ *نجم احصا* : عرض إحصائيات المستخدمين.
3️⃣ *نجم حضر* : عرض قائمة تطبيقاتك.
4️⃣ *نجم بنج* : فحص سرعة السيرفر.
5️⃣ *نجم حذف [الرقم]* : حذف مستخدم.`;
            await sock.sendMessage(jid, { text: help });
        }

        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            let count = 0;
            for (const doc of usersSnap.docs) {
                await sock.sendMessage(normalizePhone(doc.data().phone), { text: `📢 *تنبيه من نجم الإبداع!*\n🚀 تطبيق جديد متاح للتحميل:\n🔗 ${link}` });
                count++;
            }
            await sock.sendMessage(jid, { text: `✅ تم البث لـ ${count} مستخدم.` });
        }

        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            let msgText = `📊 *إحصائيات النظام:*\n👥 إجمالي المستخدمين: ${usersSnap.size}\n`;
            await sock.sendMessage(jid, { text: msgText });
        }

        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            let report = "📱 *تطبيقاتك المحقونة:*";
            apps.forEach((name, i) => report += `\n${i + 1} - ${name}`);
            await sock.sendMessage(jid, { text: report });
        }
    });

    // --- 5. منطق الاتصال الذكي (حل مشكلة التكرار) ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) qrImage = await QRCode.toDataURL(qr);
        
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 النظام متصل وشغال!"); // سيظهر مرة واحدة فقط الآن
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            
            console.log("⚠️ تم إغلاق الاتصال، السبب:", lastDisconnect.error, "إعادة المحاولة:", shouldReconnect);
            
            if (shouldReconnect) {
                // انتظار 5 ثوانٍ قبل إعادة التشغيل لمنع الحلقة المفرغة
                setTimeout(() => startBot(), 5000);
            }
        }
    });
}

// ممر فحص الجهاز
app.get("/check-device", async (req, res) => {
    const { id, appName } = req.query;
    const userSnap = await db.collection('users').where("deviceId", "==", id).where("appName", "==", appName).get();
    if (!userSnap.empty) res.status(200).send("SUCCESS");
    else res.status(404).send("NOT_FOUND");
});

// ممر طلب الكود
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, { otp, name, appName, deviceId });
    try {
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 كود الدخول لتطبيق [${appName}] هو: *${otp}*` });
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// ممر التحقق
app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    const data = tempCodes.get(phone);
    if (data && data.otp === code) {
        await db.collection('users').doc(phone).set({ 
            name: data.name, phone, appName: data.appName, deviceId: data.deviceId, date: new Date() 
        }, { merge: true });
        tempCodes.delete(phone);
        await sock.sendMessage(normalizePhone(myNumber), { text: `🆕 تم توثيق مستخدم:\n👤 ${data.name}\n📱 ${data.appName}` });
        res.status(200).send("SUCCESS");
    } else { res.status(401).send("FAIL"); }
});

app.get("/ping", (req, res) => res.send("pong"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
