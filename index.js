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
let isStarting = false;
const tempCodes = new Map(); 
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

// --- 2. النبض الحديدي (كل 10 دقائق) ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر (Status: ${res.statusCode})`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دالة الإرسال الآمن (المصفحة)
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال: الاتصال غير مستقر."); }
}

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
    if (isStarting) return;
    isStarting = true;

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

    sock.ev.on('creds.update', saveCreds);

    // --- 4. محرك الأوامر التفاعلي المطور ---
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();

            // الفلتر الحديدي: إذا كانت الرسالة "نجم" فهي أمر، غير ذلك تجاهل "isMe" تماماً لمنع الإكمال التلقائي
            if (isMe && !text.startsWith("نجم") && !userState.has(jid)) return;

            const currentState = userState.get(jid);

            if (currentState) {
                // منع البوت من "الإجابة على نفسه" (تجاهل الرسالة إذا كانت تطابق آخر سؤال أرسله البوت)
                if (isMe && text === currentState.lastPrompt) return;

                if (text.toLowerCase() === "خروج") {
                    userState.delete(jid);
                    return await safeSend(jid, { text: "❌ تم إلغاء العملية والعودة للوضع الطبيعي." });
                }

                if (currentState.command === "نشر") {
                    if (currentState.step === "LINK") {
                        currentState.link = text;
                        currentState.step = "DESC";
                        currentState.lastPrompt = "✅ تم استلام الرابط. الآن أرسل *وصف التطبيق*:";
                        userState.set(jid, currentState);
                        return await safeSend(jid, { text: currentState.lastPrompt });
                    }
                    if (currentState.step === "DESC") {
                        currentState.desc = text;
                        currentState.step = "TARGET";
                        const snap = await db.collection('users').get();
                        let apps = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                        let menu = "🎯 حدد الجمهور المستهدف:\n\n0 - 🌐 إرسال للجميع\n";
                        apps.forEach((n, i) => menu += `${i + 1} - 📱 مستخدمي [${n}]\n`);
                        currentState.lastPrompt = menu + "\n💡 أرسل رقم الخيار المطلوب.";
                        userState.set(jid, currentState);
                        return await safeSend(jid, { text: currentState.lastPrompt });
                    }
                    if (currentState.step === "TARGET") {
                        const snap = await db.collection('users').get();
                        let appsArr = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                        let targets = [];
                        
                        if (text === "0") { targets = snap.docs; } 
                        else {
                            const selectedApp = appsArr[parseInt(text) - 1];
                            if (!selectedApp) {
                                currentState.lastPrompt = "❌ رقم غير صحيح من القائمة. أرسل الرقم من الخيارات المذكورة أعلاه:";
                                userState.set(jid, currentState);
                                return await safeSend(jid, { text: currentState.lastPrompt });
                            }
                            targets = snap.docs.filter(d => (d.data().appName || "عام") === selectedApp);
                        }

                        await safeSend(jid, { text: `🚀 جاري النشر لـ ${targets.length} مستخدم...` });
                        for (const d of targets) {
                            await safeSend(normalizePhone(d.data().phone), { text: `📢 *جديد من نجم الإبداع!*\n\n${currentState.desc}\n\n🔗 للتحميل:\n${currentState.link}` });
                        }
                        userState.delete(jid);
                        return await safeSend(jid, { text: "✅ تمت العملية بنجاح تام!" });
                    }
                }
            }

            // الأوامر الأساسية (مشفرة لتجاهل تكرار البوت)
            if (text === "نجم مساعدة") {
                const help = `🌟 *لوحة تحكم نجم الإبداع:*
1️⃣ *نجم نشر* : بث (تفاعلي).
2️⃣ *نجم احصا* : إحصائيات.
3️⃣ *نجم حضر* : قائمة تطبيقاتك.
4️⃣ *نجم بنج* : حالة السيرفر.
💡 أرسل *خروج* في أي وقت.`;
                await safeSend(jid, { text: help });
            }
            if (text === "نجم نشر") {
                const prompt = "🔗 أرسل رابط التطبيق الآن:";
                userState.set(jid, { command: "نشر", step: "LINK", lastPrompt: prompt });
                await safeSend(jid, { text: prompt });
            }
            if (text === "نجم احصا") {
                const snap = await db.collection('users').get();
                await safeSend(jid, { text: `📊 إجمالي المشتركين الموثقين: ${snap.size}` });
            }
        } catch (e) { console.log("❌ خطأ معالجة أمر."); }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 النظام متصل وشغال بنسبة 100%!");
        }
        if (connection === 'close') {
            isStarting = false;
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) {
                setTimeout(() => startBot(), 10000);
            }
        }
    });
}

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
