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
            console.log(`💓 نبض النظام: مستقر ${res.statusCode}`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال: السوكيت مغلق"); }
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

async function processCommand(jid, text, sender, isMe) {
    const botTokens = ["أرسل", "تم استلام", "رقم غير صحيح", "✅", "❌", "🎯", "🌟", "🚀"];
    if (isMe && botTokens.some(token => text.includes(token))) return true;

    if (sender !== myNumber && !isMe) return false;

    const currentState = userState.get(jid);

    if (currentState) {
        if (text.toLowerCase() === "خروج") {
            userState.delete(jid);
            await safeSend(jid, { text: "❌ تم إلغاء العملية والعودة للوضع الطبيعي." });
            return true;
        }

        if (currentState.command === "نشر") {
            if (currentState.step === "waiting_link") {
                if (!text.startsWith('http')) {
                    await safeSend(jid, { text: "❌ رابط غير صحيح. أرسل رابطاً يبدأ بـ http" });
                    return true;
                }
                currentState.link = text;
                currentState.step = "waiting_desc";
                userState.set(jid, currentState);
                await safeSend(jid, { text: "✅ تم استلام الرابط. الآن أرسل *الوصف*:" });
                return true;
            }

            if (currentState.step === "waiting_desc") {
                currentState.desc = text;
                currentState.step = "waiting_target";
                userState.set(jid, currentState);
                
                const snap = await db.collection('users').get();
                let apps = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                let menu = "🎯 *اختر الجمهور المستهدف:*\n\n0 - 🌐 إرسال للجميع\n";
                apps.forEach((n, i) => menu += `${i + 1} - 📱 مستخدمي [${n}]\n`);
                await safeSend(jid, { text: menu + "\n💡 أرسل رقم الخيار المطلوب." });
                return true;
            }

            if (currentState.step === "waiting_target") {
                const snap = await db.collection('users').get();
                let appsArr = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                let targets = [];

                if (text === "0") { 
                    targets = snap.docs; 
                } else {
                    const idx = parseInt(text) - 1;
                    if (isNaN(idx) || !appsArr[idx]) {
                        await safeSend(jid, { text: "❌ رقم غير صحيح. اختر من القائمة أو أرسل *خروج*:" });
                        return true;
                    }
                    targets = snap.docs.filter(d => (d.data().appName || "عام") === appsArr[idx]);
                }

                await safeSend(jid, { text: `🚀 جاري النشر لـ ${targets.length} مستخدم...` });
                
                let successCount = 0;
                for (const d of targets) {
                    try {
                        await safeSend(normalizePhone(d.data().phone), { 
                            text: `📢 *تحديث جديد من نجم الإبداع!*\n\n${currentState.desc}\n\n🔗 ${currentState.link}` 
                        });
                        successCount++;
                    } catch (e) {}
                }
                
                userState.delete(jid); 
                await safeSend(jid, { text: `✅ تم النشر بنجاح لـ ${successCount} من أصل ${targets.length} مستخدم!` });
                return true;
            }
        }
        return true;
    }

    if (!text.startsWith("نجم")) return false;

    switch (text) {
        case "نجم":
        case "نجم مساعدة":
            await safeSend(jid, { text: `🌟 *أوامر نجم الإبداع:*

1️⃣ *نجم نشر* - إعلان تفاعلي (3 خطوات)
2️⃣ *نجم احصا* - إحصائيات المستخدمين
3️⃣ *نجم بنج* - فحص سرعة الاتصال

💡 أرسل *خروج* للإلغاء أثناء النشر.` });
            break;
            
        case "نجم نشر":
            userState.set(jid, { command: "نشر", step: "waiting_link" });
            await safeSend(jid, { text: "🔗 *خطوة 1/3*\nأرسل *رابط التطبيق* الآن:" });
            break;
            
        case "نجم احصا":
            const snap = await db.collection('users').get();
            await safeSend(jid, { text: `📊 إجمالي الموثقين: ${snap.size}` });
            break;
            
        case "نجم بنج":
            const start = Date.now();
            await safeSend(jid, { text: "🏓 جاري الفحص..." });
            await safeSend(jid, { text: `✅ الاستجابة: ${Date.now() - start}ms` });
            break;
    }
    return true;
}

async function startBot() {
    if (isStarting) return;
    isStarting = true;

    // --- 🚨 تغيير الهوية الجذري ---
    const folder = './auth_star_nexus_prime_v100'; 
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    try {
        const sessionSnap = await db.collection('session').doc('session_nexus_prime_v100').get();
        if (sessionSnap.exists) fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
    } catch (e) {}
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, auth: state, logger: pino({ level: "silent" }), 
        // بصمة متصفح جديدة كلياً
        browser: ["iPad", "Safari", "17.0"],
        printQRInTerminal: false, syncFullHistory: false,
        connectTimeoutMs: 60000, keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            const now = Math.floor(Date.now() / 1000);
            if (now - msg.messageTimestamp > 15) return;
            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
            if (!text) return;
            await processCommand(jid, text, sender, isMe);
        } catch (e) {}
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 النظام متصل ومستقر بالهوية الجديدة.");
            await db.collection('session').doc('session_nexus_prime_v100').set(state.creds, { merge: true });
            setTimeout(() => {
                safeSend(normalizePhone(myNumber), { text: "🌟 *تم تحديث الهوية وتفعيل النظام بنجاح!*" });
            }, 2000);
        }
        if (connection === 'close') {
            isStarting = false;
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) setTimeout(() => startBot(), 10000);
        }
    });
}

// --- نقاط النهاية (API) ---
app.get("/check-device", async (req, res) => {
    const { id, appName } = req.query;
    const snap = await db.collection('users').where("deviceId", "==", id).where("appName", "==", appName).get();
    res.status(snap.empty ? 404 : 200).send(snap.empty ? "NOT_FOUND" : "SUCCESS");
});

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, { otp, name, appName, deviceId });
    try {
        await safeSend(normalizePhone(phone), { text: `🔐 أهلاً ${name}، كود تفعيل [${appName}] هو: *${otp}*` });
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
        await safeSend(normalizePhone(myNumber), { text: `🆕 مستخدم جديد سجل الآن: ${data.name}` });
        res.status(200).send("SUCCESS");
    } else res.status(401).send("FAIL");
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
