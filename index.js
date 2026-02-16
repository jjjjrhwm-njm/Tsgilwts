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
const userState = new Map(); // تخزين حالة المحادثة التفاعلية
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
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, () => {}).on('error', () => {});
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
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try { await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true }); } catch (e) {}
    });

    // --- 4. محرك الأوامر التفاعلي المطور ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const sender = jid.split('@')[0].split(':')[0];
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || "";

        // التحقق من أن المرسل هو أنت (حتى لو راسلت نفسك)
        if (sender !== myNumber) return;

        // فحص إذا كان هناك محادثة جارية حالياً
        const currentState = userState.get(jid);

        if (currentState) {
            // تنفيذ خطوات أمر "نجم نشر"
            if (currentState.command === "نشر") {
                if (currentState.step === "LINK") {
                    currentState.link = text;
                    currentState.step = "DESC";
                    userState.set(jid, currentState);
                    return await sock.sendMessage(jid, { text: "✅ تم استلام الرابط.\n\n📝 الآن أرسل *وصف التطبيق* الذي سيظهر للمشتركين:" });
                }
                if (currentState.step === "DESC") {
                    currentState.desc = text;
                    currentState.step = "TARGET";
                    userState.set(jid, currentState);
                    return await sock.sendMessage(jid, { text: "✅ تم استلام الوصف.\n\n🎯 حدد الجمهور الآن، أرسل:\n1 - للجميع\n2 - تخصيص (تطبيقات معينة)" });
                }
                if (currentState.step === "TARGET") {
                    if (text === "1") {
                        await sock.sendMessage(jid, { text: "🚀 جاري النشر للجميع، انتظر قليلاً..." });
                        const usersSnap = await db.collection('users').get();
                        let count = 0;
                        for (const doc of usersSnap.docs) {
                            await sock.sendMessage(normalizePhone(doc.data().phone), { 
                                text: `📢 *تحديث جديد من نجم الإبداع!*\n\n${currentState.desc}\n\n🔗 تحميل من هنا:\n${currentState.link}` 
                            });
                            count++;
                        }
                        userState.delete(jid);
                        return await sock.sendMessage(jid, { text: `✅ تمت العملية بنجاح لـ ${count} مستخدم.` });
                    } else if (text === "2") {
                        userState.delete(jid);
                        return await sock.sendMessage(jid, { text: "⏳ ميزة التخصيص قيد التطوير، تم إلغاء العملية حالياً." });
                    }
                }
            }
            
            // إلغاء أي أمر
            if (text.toLowerCase() === "خروج") {
                userState.delete(jid);
                return await sock.sendMessage(jid, { text: "❌ تم إلغاء العملية والعودة للوضع الطبيعي." });
            }
        }

        // الأوامر الأساسية (بداية المحادثة)
        if (text === "نجم مساعدة") {
            const help = `🌟 *لوحة تحكم نجم الإبداع التفاعلية:*

1️⃣ *نجم نشر* : البدء في عملية بث تطبيق.
2️⃣ *نجم احصا* : عرض تقرير المستخدمين.
3️⃣ *نجم حضر* : قائمة تطبيقاتك.
4️⃣ *نجم حذف* : مسح رقم معين.
5️⃣ *نجم بنج* : فحص حالة السيرفر.

💡 أرسل كلمة *خروج* في أي وقت لإلغاء أي أمر جاري.`;
            await sock.sendMessage(jid, { text: help });
        }

        if (text === "نجم نشر") {
            userState.set(jid, { command: "نشر", step: "LINK" });
            await sock.sendMessage(jid, { text: "📢 بدأنا عملية النشر.\n\n🔗 من فضلك أرسل *رابط التطبيق* الآن:" });
        }

        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            let msgText = `📊 *إحصائيات النظام:*\n👥 إجمالي المشتركين: ${usersSnap.size}\n`;
            await sock.sendMessage(jid, { text: msgText });
        }

        if (text === "نجم بنج") {
            await sock.sendMessage(jid, { text: "🚀 السيرفر حديدي ومستعد لتنفيذ أوامرك!" });
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 النظام متصل وشغال!");
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) setTimeout(() => startBot(), 5000);
        }
    });
}

// ممرات الـ API
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
        await sock.sendMessage(normalizePhone(phone), { text: `🔐 كود تسجيل دخولك لتطبيق [${appName}] هو: *${otp}*` });
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
