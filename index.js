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

// --- 3. محرك تمييز الأرقام الذكي (Smart Country Code) ---
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); // تنظيف من أي رموز

    // إزالة الأصفار الزائدة في البداية
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);

    // منطق التمييز الذكي
    // السعودية (966): الرقم يبدأ بـ 5 وطوله 9 أرقام
    if (clean.length === 9 && clean.startsWith('5')) {
        clean = '966' + clean;
    }
    // اليمن (967): الرقم يبدأ بـ 7 وطوله 9 أرقام
    else if (clean.length === 9 && (clean.startsWith('77') || clean.startsWith('73') || clean.startsWith('71') || clean.startsWith('70'))) {
        clean = '967' + clean;
    }
    // قطر (974): الرقم طوله 8 أرقام ويبدأ بـ (3,4,5,6,7)
    else if (clean.length === 8 && /^[34567]/.test(clean)) {
        clean = '974' + clean;
    }
    // إذا كان الرقم طويلاً أصلاً (به مفتاح دولة) نتركه كما هو

    return clean + "@s.whatsapp.net";
}

async function startBot() {
    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    // استعادة الهوية المستقرة
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
        try {
            await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true });
        } catch (e) {}
    });

    // --- نظام الأوامر المطور (نجم نشر، نجم احصا، نجم حضر) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const sender = msg.key.remoteJid.split('@')[0].split(':')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (sender !== myNumber) return;

        // 1. أمر النشر
        if (text.startsWith("نجم نشر")) {
            const link = text.replace("نجم نشر", "").trim();
            const usersSnap = await db.collection('users').get();
            let count = 0;
            for (const doc of usersSnap.docs) {
                await sock.sendMessage(normalizePhone(doc.data().phone), { 
                    text: `📢 تطبيق جديد من نجم الإبداع!\n🚀 حمله الآن من هنا: ${link}` 
                });
                count++;
            }
            await sock.sendMessage(msg.key.remoteJid, { text: `✅ تم إرسال الرابط لـ ${count} مستخدم.` });
        }

        // 2. أمر الإحصائيات
        if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            await sock.sendMessage(msg.key.remoteJid, { text: `📊 إحصائياتك الحديدية:\n👥 عدد المستخدمين الموثقين: ${usersSnap.size}` });
        }

        // 3. أمر الحضر/القائمة
        if (text === "نجم حضر") {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            let report = "📱 تطبيقاتك المبرمجة:\n";
            apps.forEach((name, i) => report += `${i + 1} - ${name}\n`);
            await sock.sendMessage(msg.key.remoteJid, { text: report + "\n💡 أرسل الرقم لعرض المشتركين." });
        }

        // عرض تفصيلي للمستخدمين
        if (/^\d+$/.test(text) && text.length < 3) {
            const usersSnap = await db.collection('users').get();
            let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
            const selected = apps[parseInt(text) - 1];
            if (selected) {
                let list = `👥 مستخدمي [${selected}]:\n`;
                usersSnap.docs.filter(d => (d.data().appName || "عام") === selected).forEach(d => {
                    list += `👤 ${d.data().name} (${d.data().phone})\n`;
                });
                await sock.sendMessage(msg.key.remoteJid, { text: list });
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') qrImage = "DONE";
        if (connection === 'close') startBot();
    });
}

// ممر فحص الجهاز
app.get("/check-device", async (req, res) => {
    const { id } = req.query;
    const userSnap = await db.collection('users').where("deviceId", "==", id).get();
    if (!userSnap.empty) res.status(200).send("SUCCESS");
    else res.status(404).send("NOT_FOUND");
});

// ممر طلب الكود (التخزين المؤقت للتحقق الصارم)
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    tempCodes.set(phone, { otp, name, appName, deviceId });

    try {
        // استخدام المحرك الذكي للإرسال
        const jid = normalizePhone(phone);
        await sock.sendMessage(jid, { text: `🔐 يا ${name}، كود التحقق الخاص بك هو: *${otp}*` });
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// ممر التحقق (التسجيل الدائم بعد النجاح)
app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    const data = tempCodes.get(phone);

    if (data && data.otp === code) {
        await db.collection('users').doc(phone).set({ 
            name: data.name, phone, appName: data.appName || "عام", 
            deviceId: data.deviceId, date: new Date() 
        }, { merge: true });

        await sock.sendMessage(normalizePhone(myNumber), { 
            text: `✅ تم توثيق مستخدم جديد!\n👤 الاسم: ${data.name}\n📱 التطبيق: ${data.appName}` 
        });

        tempCodes.delete(phone);
        res.status(200).send("SUCCESS");
    } else {
        res.status(401).send("FAIL");
    }
});

app.get("/ping", (req, res) => res.send("pong"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "<h1 style='color:green;text-align:center;'>✅ Connected</h1>" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
