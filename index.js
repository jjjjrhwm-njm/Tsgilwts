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
            console.log(`💓 نبض حديدي: النظام مستقر ${res.statusCode}`);
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
        connectTimeoutMs: 60000, keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    // --- 4. محرك الأوامر الذكي المصفح ضد التكرار ---
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();

            // 🛑 القاعدة الذهبية: إذا كان البوت هو من أرسل الرسالة (آلياً)، تجاهلها فوراً لمنع التكرار
            // نميز رسائل البوت بأنها لا تبدأ بـ "نجم" وليست من "إنسان" يستخدم الوتساب ويب
            if (isMe && !text.startsWith("نجم") && !userState.has(jid)) return;

            // التحقق من الإدمن (أنت فقط)
            if (sender !== myNumber && !isMe) return;

            const currentState = userState.get(jid);

            if (currentState) {
                // منع البوت من الرد على إشعاراته الخاصة
                if (isMe && (text.includes("أرسل") || text.includes("تم استلام") || text.includes("رقم غير صحيح"))) return;

                if (text.toLowerCase() === "خروج") {
                    userState.delete(jid);
                    return await safeSend(jid, { text: "❌ تم إلغاء العملية والعودة للوضع الطبيعي." });
                }

                if (currentState.command === "نشر") {
                    if (currentState.step === "LINK") {
                        currentState.link = text;
                        currentState.step = "DESC";
                        userState.set(jid, currentState);
                        return await safeSend(jid, { text: "✅ تم استلام الرابط. الآن أرسل *الوصف*:" });
                    }
                    if (currentState.step === "DESC") {
                        currentState.desc = text;
                        currentState.step = "TARGET";
                        userState.set(jid, currentState);
                        const snap = await db.collection('users').get();
                        let apps = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                        let menu = "🎯 حدد الجمهور المستهدف:\n\n0 - 🌐 إرسال للجميع\n";
                        apps.forEach((n, i) => menu += `${i + 1} - 📱 مستخدمي [${n}]\n`);
                        return await safeSend(jid, { text: menu + "\n💡 أرسل رقم الخيار المطلوب." });
                    }
                    if (currentState.step === "TARGET") {
                        const snap = await db.collection('users').get();
                        let appsArr = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                        let targets = [];

                        if (text === "0") { targets = snap.docs; } 
                        else {
                            const idx = parseInt(text) - 1;
                            if (isNaN(idx) || !appsArr[idx]) {
                                // أرسل خطأ ولكن لا تحفظه كـ Prompt لكي لا يكرر البوت نفسه
                                return await safeSend(jid, { text: "❌ رقم غير صحيح. أرسل الرقم الصحيح من القائمة أعلاه أو أرسل *خروج*:" });
                            }
                            targets = snap.docs.filter(d => (d.data().appName || "عام") === appsArr[idx]);
                        }

                        await safeSend(jid, { text: `🚀 جاري النشر لـ ${targets.length} مستخدم...` });
                        for (const d of targets) {
                            await safeSend(normalizePhone(d.data().phone), { text: `📢 *تحديث جديد من نجم الإبداع!*\n\n${currentState.desc}\n\n🔗 ${currentState.link}` });
                        }
                        userState.delete(jid); // مسح الحالة فور الانتهاء لكي يتوقف البوت عن التدخل
                        return await safeSend(jid, { text: "✅ تمت العملية بنجاح تام! البوت الآن في وضع الاستعداد." });
                    }
                }
            }

            // الأوامر الأساسية
            if (text === "نجم مساعدة") {
                await safeSend(jid, { text: "🌟 *أوامر نجم:*\n1- نجم نشر\n2- نجم احصا\n3- نجم بنج\n💡 أرسل *خروج* للإلغاء." });
            }
            if (text === "نجم نشر") {
                userState.set(jid, { command: "نشر", step: "LINK" });
                await safeSend(jid, { text: "🔗 أرسل *رابط التطبيق* الآن:" });
            }
            if (text === "نجم احصا") {
                const snap = await db.collection('users').get();
                await safeSend(jid, { text: `📊 إجمالي الموثقين: ${snap.size}` });
            }
        } catch (e) { console.log("❌ خطأ في معالجة الرسالة"); }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 النظام متصل ومستقر الآن.");
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
        await safeSend(normalizePhone(phone), { text: `🔐 أهلاً ${name}، كود دخولك هو: *${otp}*` });
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
        await safeSend(normalizePhone(myNumber), { text: `🆕 مستخدم جديد: ${data.name}` });
        res.status(200).send("SUCCESS");
    } else { res.status(401).send("FAIL"); }
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));
app.listen(process.env.PORT || 10000, () => startBot());
