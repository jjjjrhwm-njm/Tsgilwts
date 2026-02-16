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
let isConnecting = false;
const tempCodes = new Map(); 
const userState = new Map(); // لإدارة خطوات "نجم نشر"
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

// --- 2. النبض الحديدي (كل 10 دقائق) ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر (Code: ${res.statusCode})`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دالة الإرسال الآمن (Shield)
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ حماية: تعذر الإرسال بسبب حالة السوكيت."); }
}

// محرك تمييز الدول الذكي
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
    if (isConnecting) return;
    isConnecting = true;

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
        version, auth: state, logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false, syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try { await db.collection('session').doc('session_otp_stable').set(state.creds, { merge: true }); } catch (e) {}
    });

    // --- 4. محرك الأوامر التفاعلي المصفح ---
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            // حماية: تجاهل الرسائل القديمة (أكثر من 10 ثوانٍ) لمنع خطأ 428
            const messageTimestamp = msg.messageTimestamp;
            const now = Math.floor(Date.now() / 1000);
            if (now - messageTimestamp > 10) return;

            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";

            // السماح لك بالتحكم (رقمك أو أي رسالة تخرج من حساب البوت)
            if (!isMe && sender !== myNumber) return;

            const currentState = userState.get(jid);

            // منطق الخطوات التفاعلية (نجم نشر)
            if (currentState && currentState.command === "نشر") {
                if (text.toLowerCase() === "خروج") {
                    userState.delete(jid);
                    return await safeSend(jid, { text: "❌ تم إلغاء العملية." });
                }

                if (currentState.step === "LINK") {
                    currentState.link = text;
                    currentState.step = "DESC";
                    userState.set(jid, currentState);
                    return await safeSend(jid, { text: "✅ الرابط تمام.\n\n📝 الآن أرسل *وصف التطبيق* (النص الذي سيظهر للناس):" });
                }
                
                if (currentState.step === "DESC") {
                    currentState.desc = text;
                    currentState.step = "TARGET";
                    userState.set(jid, currentState);
                    const usersSnap = await db.collection('users').get();
                    let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
                    let menu = "🎯 حدد الجمهور المستهدف:\n\n0 - 🌐 إرسال للجميع\n";
                    apps.forEach((name, i) => menu += `${i + 1} - 📱 مستخدمي [${name}]\n`);
                    return await safeSend(jid, { text: menu + "\n💡 أرسل رقم الخيار المطلوب." });
                }

                if (currentState.step === "TARGET") {
                    const usersSnap = await db.collection('users').get();
                    let targets = [];
                    if (text === "0") {
                        targets = usersSnap.docs;
                    } else {
                        let apps = [...new Set(usersSnap.docs.map(d => d.data().appName || "عام"))];
                        const selectedApp = apps[parseInt(text) - 1];
                        if (!selectedApp) return await safeSend(jid, { text: "❌ رقم غير صحيح من القائمة." });
                        targets = usersSnap.docs.filter(d => (d.data().appName || "عام") === selectedApp);
                    }

                    await safeSend(jid, { text: `🚀 جاري البث لـ ${targets.length} مستخدم...` });
                    for (const doc of targets) {
                        const u = doc.data();
                        await safeSend(normalizePhone(u.phone), { 
                            text: `📢 *تحديث جديد من نجم الإبداع!*\n\n${currentState.desc}\n\n🔗 للتحميل:\n${currentState.link}` 
                        });
                    }
                    userState.delete(jid);
                    return await safeSend(jid, { text: "✅ تمت عملية النشر بنجاح تام!" });
                }
            }

            // الأوامر الأساسية
            if (text === "نجم مساعدة") {
                const menu = `🌟 *لوحة تحكم نجم الإبداع الحديدية:*
                
1️⃣ *نجم نشر* : بث رابط (تفاعلي).
2️⃣ *نجم احصا* : تقرير المستخدمين.
3️⃣ *نجم حضر* : قائمة التطبيقات.
4️⃣ *نجم بنج* : سرعة السيرفر.
5️⃣ *نجم مسح* : تصفير الذاكرة.

💡 أرسل *خروج* لإلغاء أي خطوة.`;
                await safeSend(jid, { text: menu });
            }

            if (text === "نجم نشر") {
                userState.set(jid, { command: "نشر", step: "LINK" });
                await safeSend(jid, { text: "📢 بدأنا عملية النشر.\n\n🔗 أرسل *رابط التطبيق* الآن:" });
            }

            if (text === "نجم احصا") {
                const snap = await db.collection('users').get();
                await safeSend(jid, { text: `📊 إجمالي المشتركين الموثقين: ${snap.size}` });
            }

            if (text === "نجم بنج") {
                const start = Date.now();
                await safeSend(jid, { text: "📡" });
                await safeSend(jid, { text: `🚀 الاستجابة: ${Date.now() - start}ms\n💓 الحالة: مصفح 100%` });
            }
        } catch (e) { console.log("❌ خطأ داخلي في معالجة الأمر."); }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isConnecting = false;
            console.log("🚀 النظام متصل وشغال بنسبة 100%!");
        }
        if (connection === 'close') {
            isConnecting = false;
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) {
                console.log("⚠️ تعثر الاتصال، جاري الإنعاش بعد 5 ثوانٍ...");
                setTimeout(() => startBot(), 5000);
            }
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
        await safeSend(normalizePhone(phone), { text: `🔐 أهلاً ${name}، كود دخول [${appName}] هو: *${otp}*` });
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
        await safeSend(normalizePhone(myNumber), { text: `🆕 موثق جديد: ${data.name} (${phone})` });
        res.status(200).send("SUCCESS");
    } else res.status(401).send("FAIL");
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
