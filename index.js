const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json());

// 1. إعداد الخزانة السحابية (Firebase)
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = "7650083401"; // معرفك الخاص للتحكم التام

// مخزن مؤقت لحالات الإدارة (نشر الإعلانات)
const userState = new Map();

// --- [ محرك التنسيق الذكي للأرقام العالمية ] ---
function globalNormalize(phone) {
    let clean = phone.replace(/\D/g, ''); // إزالة أي رموز أو مسافات
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);

    // ذكاء التوزيع حسب المنطقة (SA, YE, QA)
    if (clean.length === 9 && clean.startsWith('5')) return '966' + clean; // السعودية
    if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) return '967' + clean; // اليمن
    if (clean.length === 8 && /^[34567]/.test(clean)) return '974' + clean; // قطر
    
    // إذا كان الرقم دولياً مسبقاً، نرجعه كما هو
    return clean;
}

// --- [ بوابة الحماية الذكية ] ---

// 1. فحص تصريح الدخول (يمنع الدخول إلا للموثقين)
app.get("/check-device", async (req, res) => {
    const devId = req.query.id || req.query.deviceId;
    const appName = req.query.app || req.query.appName;

    try {
        const userRef = db.collection('users')
            .where('deviceId', '==', devId)
            .where('appName', '==', appName)
            .where('verified', '==', true);
        
        const snap = await userRef.get();
        if (!snap.empty) {
            res.status(200).send("ALLOWED"); // المستخدم مسجل لهذا التطبيق
        } else {
            res.status(401).send("UNAUTHORIZED"); // إجبار التطبيق على فتح واجهة التسجيل
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

// 2. طلب الكود (التنسيق -> التوليد -> الإرسال عبر Infobip)
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const normalizedPhone = globalNormalize(phone); // معالجة الرقم ذكياً
    const otp = Math.floor(100000 + Math.random() * 899999).toString(); // كود احترافي 6 أرقام

    try {
        // تخزين الكود في Firebase مع ربطه بالرقم والجهاز
        await db.collection('otps').doc(normalizedPhone).set({
            code: otp,
            appName: appName,
            deviceId: deviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // تنفيذ أمر الإرسال السحابي لـ Infobip
        await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
            messages: [{
                destinations: [{ to: normalizedPhone }],
                from: "Njm-RK",
                text: `كود التحقق الخاص بك في تطبيق ${appName} هو: ${otp}`
            }]
        }, { headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` } });

        // إشعارك فوراً بالتقرير الكامل
        bot.telegram.sendMessage(ADMIN_ID, `🎯 *عملية تسجيل جديدة*\n📱 التطبيق: ${appName}\n👤 الاسم: ${name}\n📞 الرقم: ${normalizedPhone}\n🔑 الكود: \`${otp}\``, { parse_mode: "Markdown" });

        res.status(200).send("SUCCESS");
    } catch (e) { res.status(200).send("SUCCESS"); }
});

// 3. التحقق الصارم من الكود (المطابقة السحابية)
app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    const normalizedPhone = globalNormalize(phone);

    try {
        const otpDoc = await db.collection('otps').doc(normalizedPhone).get();
        if (otpDoc.exists && otpDoc.data().code === code) {
            const data = otpDoc.data();
            // توثيق نهائي للجهاز لفتح التطبيق للأبد
            await db.collection('users').doc(`${normalizedPhone}_${data.appName}`).set({
                phone: normalizedPhone, 
                deviceId: data.deviceId, 
                appName: data.appName, 
                verified: true 
            }, { merge: true });
            res.status(200).send("VERIFIED");
        } else {
            res.status(401).send("INVALID"); // الكود خطأ: التطبيق لن يفتح
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

// --- [ أوامر الإدارة المتكاملة ] ---

bot.on('text', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    const text = ctx.message.text;
    const state = userState.get(ctx.chat.id);

    if (state) {
        if (text === "خروج") { userState.delete(ctx.chat.id); return ctx.reply("❌ تم الإلغاء."); }

        if (state.step === "waiting_link") {
            state.link = text; state.step = "waiting_desc";
            return ctx.reply("✅ تم؛ الآن أرسل *الوصف*:");
        }

        if (state.step === "waiting_desc") {
            state.desc = text; state.step = "waiting_target";
            const snap = await db.collection('users').get();
            let apps = [...new Set(snap.docs.map(d => d.data().appName))];
            let menu = "🎯 *اختر جمهور النشر:*\n\n0 - 🌐 الكل\n";
            apps.forEach((n, i) => menu += `${i + 1} - 📱 [${n}]\n`);
            return ctx.reply(menu + "\n💡 أرسل رقم الخيار.");
        }

        if (state.step === "waiting_target") {
            const snap = await db.collection('users').get();
            let appsArr = [...new Set(snap.docs.map(d => d.data().appName))];
            let targets = (text === "0") ? snap.docs : snap.docs.filter(d => d.data().appName === appsArr[parseInt(text) - 1]);

            ctx.reply(`🚀 جاري النشر لـ ${targets.length} مستخدم...`);
            for (const d of targets) {
                try {
                    await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
                        messages: [{ destinations: [{ to: d.data().phone }], from: "Njm-RK", text: `${state.desc}\n${state.link}` }]
                    }, { headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` } });
                } catch (e) {}
            }
            userState.delete(ctx.chat.id);
            return ctx.reply("✅ تم النشر بنجاح.");
        }
    }

    switch (text) {
        case "نجم": ctx.reply(`🌟 *لوحة تحكم نجم الإبداع:*
1️⃣ نجم نشر - إرسال حملة SMS (3 خطوات)
2️⃣ نجم احصا - جرد الضحايا والبيانات
3️⃣ نجم بنج - فحص استقرار السيرفر`); break;
        case "نجم نشر": userState.set(ctx.chat.id, { step: "waiting_link" }); ctx.reply("🔗 *خطوة 1/3*\nأرسل رابط التطبيق:"); break;
        case "نجم احصا": 
            const snap = await db.collection('users').get();
            let stats = "📊 *الإحصائيات الميدانية:*\n";
            let counts = {};
            snap.docs.forEach(d => counts[d.data().appName] = (counts[d.data().appName] || 0) + 1);
            for (let app in counts) stats += `\n📱 ${app}: ${counts[app]}`;
            ctx.reply(stats); break;
    }
});

app.listen(process.env.PORT || 10000);
bot.launch();
