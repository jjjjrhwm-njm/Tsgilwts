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

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
const tempCodes = new Map();
const myNumber = "966554526287@s.whatsapp.net"; // رقمك للتحكم

// إعداد Firebase
const firebaseConfig = process.env.FIREBASE_CONFIG;
const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    return clean + "@s.whatsapp.net";
}

async function startBot() {
    const folder = './auth_info_stable';
    const { state, saveCreds } = await useMultiFileAuthState(folder);

    // استعادة الجلسة من Firebase لضمان الاستقرار
    try {
        const sessionSnap = await db.collection('session').doc('creds').get();
        if (sessionSnap.exists && !fs.existsSync(`${folder}/creds.json`)) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
        }
    } catch (e) {}

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["CreativeStar", "Chrome", "1.0"]
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await db.collection('session').doc('creds').set(state.creds, { merge: true });
    });

    // --- نظام أوامر الوتساب (نجم نشر، نجم احصا، نجم حضر) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (sender !== myNumber) return; // السماح لك فقط بالتحكم

        // 1. أمر النشر: نجم نشر [الرابط]
        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            let count = 0;
            usersSnap.forEach(async (doc) => {
                const user = doc.data();
                await sock.sendMessage(normalizePhone(user.phone), { text: `🔥 تطبيق جديد!\nحمله من هنا: ${link}` });
                count++;
            });
            await sock.sendMessage(myNumber, { text: `✅ تم البدء بنشر الرابط لـ ${count} مستخدم.` });
        }

        // 2. أمر الإحصائيات: نجم احصا
        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            await sock.sendMessage(myNumber, { text: `📊 إجمالي المستخدمين المسجلين: ${usersSnap.size}` });
        }

        // 3. أمر الحضر/القائمة: نجم حضر
        if (text === "نجم حضر") {
            const apps = ["راشد", "نت فلكس"];
            let report = "📱 اختر التطبيق لعرض المستخدمين:\n";
            apps.forEach((name, i) => report += `${i + 1} - تطبيق ${name}\n`);
            await sock.sendMessage(myNumber, { text: report });
        }

        // معالجة اختيار رقم التطبيق (1 أو 2)
        if (text === "1" || text === "2") {
            const appName = text === "1" ? "Rashid" : "Netflix";
            const usersSnap = await db.collection('users').where("app", "==", appName).get();
            let list = `👥 مستخدمي تطبيق ${appName}:\n`;
            usersSnap.forEach(doc => {
                const u = doc.data();
                list += `👤 ${u.name} - 📞 ${u.phone}\n`;
            });
            await sock.sendMessage(myNumber, { text: list });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') qrImage = "DONE";
    });
}

// ممر طلب الكود المحدث (حفظ في Firebase وإشعار المطور)
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);

    try {
        // حفظ دائم في Firebase
        await db.collection('users').doc(phone).set({ name, phone, app: appName, date: new Date() }, { merge: true });
        
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 أهلاً يا ${name}، كودك هو: *${otp}*` });
        await sock.sendMessage(myNumber, { text: `🆕 سجل مستخدم جديد!\n👤 الاسم: ${name}\n📞 الرقم: ${phone}\n📱 التطبيق: ${appName}` });
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

app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
