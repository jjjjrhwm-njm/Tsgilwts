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
const myNumber = "966554526287"; // رقمك للتحكم

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
            console.log("💓 نبض حديدي: السيرفر مستيقظ");
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
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"] 
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try { await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true }); } catch (e) {}
    });

    // --- 4. محرك الأوامر الحديدي ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        
        // جلب رقم المرسل (سواء كان أنت أو غيرك)
        const jid = msg.key.remoteJid;
        const sender = jid.split('@')[0].split(':')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // السماح بالأوامر فقط إذا كان المرسل هو رقمك الخاص
        if (sender !== myNumber) return;

        // 🟢 أمر: نجم مساعدة
        if (text === "نجم مساعدة") {
            const help = `🌟 *قائمة أوامر نجم الإبداع للتحكم:*
            
1️⃣ *نجم نشر [الرابط]* : نشر تطبيق لكل المشتركين.
2️⃣ *نجم احصا* : عرض عدد المستخدمين وتفاصيلهم.
3️⃣ *نجم حضر* : عرض قائمة التطبيقات النشطة.
4️⃣ *نجم فحص [الرقم]* : التأكد من تسجيل رقم معين.
5️⃣ *نجم حذف [الرقم]* : حذف مستخدم من قاعدة البيانات.
6️⃣ *نجم بنج* : فحص سرعة استجابة السيرفر.
7️⃣ *نجم مسح* : مسح الذاكرة المؤقتة للأكواد.`;
            await sock.sendMessage(jid, { text: help });
        }

        // 🟢 أمر: نجم نشر
        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            let count = 0;
            for (const doc of usersSnap.docs) {
                await sock.sendMessage(normalizePhone(doc.data().phone), { text: `📢 *تنبيه من نجم الإبداع!*\n🚀 تطبيق جديد متاح الآن للتحميل:\n🔗 ${link}` });
                count++;
            }
            await sock.sendMessage(jid, { text: `✅ تمت عملية البث بنجاح لـ ${count} مستخدم.` });
        }

        // 🟢 أمر: نجم احصا
        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            let msgText = `📊 *إحصائيات النظام الحديدي:*\n\n👥 إجمالي المستخدمين: ${usersSnap.size}\n\n`;
            usersSnap.forEach(doc => {
                const u = doc.data();
                msgText += `👤 ${u.name} | 📱 ${u.appName}\n`;
            });
            await sock.sendMessage(jid, { text: msgText });
        }

        // 🟢 أمر: نجم حضر (عرض التطبيقات)
        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            let report = "📱 *قائمة تطبيقاتك المحقونة:*\n";
            apps.forEach((name, i) => report += `\n${i + 1} - تطبيق: *${name}*`);
            await sock.sendMessage(jid, { text: report });
        }

        // 🟢 أمر: نجم حذف
        if (text.startsWith("نجم حذف")) {
            const target = text.replace("نجم حذف", "").trim();
            await db.collection('users').doc(target).delete();
            await sock.sendMessage(jid, { text: `🗑️ تم حذف الرقم ${target} من النظام.` });
        }

        // 🟢 أمر: نجم بنج
        if (text === "نجم بنج") {
            const start = Date.now();
            await sock.sendMessage(jid, { text: "⏳ جاري الفحص..." });
            const lat = Date.now() - start;
            await sock.sendMessage(jid, { text: `🚀 سرعة السيرفر: ${lat}ms\n💓 الحالة: مستقر 24/7` });
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 النظام متصل وشغال!");
        }
        if (connection === 'close') startBot();
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
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 أهلاً يا ${name}، كود الدخول لتطبيق [${appName}] هو: *${otp}*` });
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
        await sock.sendMessage(normalizePhone(myNumber), { text: `🆕 *عضو جديد موثق:*\n👤 الاسم: ${data.name}\n📱 التطبيق: ${data.appName}\n📞 الرقم: ${phone}` });
        res.status(200).send("SUCCESS");
    } else { res.status(401).send("FAIL"); }
});

app.get("/ping", (req, res) => res.send("pong"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
