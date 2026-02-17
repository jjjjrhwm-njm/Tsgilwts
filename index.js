const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json());

// 1. إعداد Firebase بالخزانة tsgil-wts
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = "7650083401"; // معرفك في تليجرام

// مخزن مؤقت لحالة الإدمن (مثل نظام الوتساب القديم)
const userState = new Map();

// --- [ منطق الربط مع التطبيقات المحقونة ] ---

// فحص الجهاز: يفرق بين التطبيقات (يفتح التطبيق فقط إذا كان مسجلاً لنفس التطبيق)
app.get("/check-device", async (req, res) => {
    const devId = req.query.id || req.query.deviceId;
    const appName = req.query.app || req.query.appName; // استقبال اسم التطبيق من Smali

    try {
        const userRef = db.collection('users')
            .where('deviceId', '==', devId)
            .where('appName', '==', appName)
            .where('verified', '==', true);
        
        const snap = await userRef.get();
        if (!snap.empty) {
            res.status(200).send("ALLOWED"); // مسجل لهذا التطبيق تحديداً
        } else {
            res.status(401).send("UNAUTHORIZED"); // جديد أو تطبيق مختلف
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

// طلب الكود وإرسال SMS
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 899999).toString();

    try {
        // حفظ الكود واسم التطبيق للتحقق
        await db.collection('otps').doc(phone).set({
            code: otp,
            appName: appName,
            deviceId: deviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
            messages: [{
                destinations: [{ to: phone }],
                from: "Njm-RK",
                text: `كود التحقق الخاص بك في تطبيق ${appName} هو: ${otp}`
            }]
        }, { headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` } });

        bot.telegram.sendMessage(ADMIN_ID, `🎯 *كود جديد مرسل*\n📱 التطبيق: ${appName}\n📞: ${phone}\n👤: ${name}\n🔑: \`${otp}\``, { parse_mode: "Markdown" });
        res.status(200).send("SUCCESS");
    } catch (e) { res.status(200).send("SUCCESS"); }
});

// التحقق من الكود
app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    try {
        const otpDoc = await db.collection('otps').doc(phone).get();
        if (otpDoc.exists && otpDoc.data().code === code) {
            const data = otpDoc.data();
            // توثيق المستخدم لهذا التطبيق المعين
            await db.collection('users').doc(`${phone}_${data.appName}`).set({
                phone, 
                deviceId: data.deviceId, 
                appName: data.appName, 
                verified: true 
            }, { merge: true });
            res.status(200).send("VERIFIED");
        } else {
            res.status(401).send("INVALID");
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

// --- [ أوامر الإدارة التفاعلية (مثل كود الوتساب) ] ---

bot.on('text', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    const text = ctx.message.text;
    const state = userState.get(ctx.chat.id);

    // نظام الخطوات (نجم نشر)
    if (state) {
        if (text === "خروج") {
            userState.delete(ctx.chat.id);
            return ctx.reply("❌ تم إلغاء العملية.");
        }

        if (state.step === "waiting_link") {
            state.link = text;
            state.step = "waiting_desc";
            return ctx.reply("✅ تم استلام الرابط. الآن أرسل *الوصف*:");
        }

        if (state.step === "waiting_desc") {
            state.desc = text;
            state.step = "waiting_target";
            const snap = await db.collection('users').get();
            let apps = [...new Set(snap.docs.map(d => d.data().appName))];
            let menu = "🎯 *اختر الجمهور المستهدف:*\n\n0 - 🌐 الجميع\n";
            apps.forEach((n, i) => menu += `${i + 1} - 📱 [${n}]\n`);
            return ctx.reply(menu + "\n💡 أرسل رقم الخيار.");
        }

        if (state.step === "waiting_target") {
            const snap = await db.collection('users').get();
            let appsArr = [...new Set(snap.docs.map(d => d.data().appName))];
            let targets = [];
            
            if (text === "0") { targets = snap.docs; }
            else {
                const idx = parseInt(text) - 1;
                if (isNaN(idx) || !appsArr[idx]) return ctx.reply("❌ اختيار خطأ.");
                targets = snap.docs.filter(d => d.data().appName === appsArr[idx]);
            }

            ctx.reply(`🚀 جاري النشر لـ ${targets.length} مستخدم...`);
            for (const d of targets) {
                try {
                    await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
                        messages: [{ destinations: [{ to: d.data().phone }], from: "Njm-RK", text: `${state.desc}\n${state.link}` }]
                    }, { headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` } });
                } catch (e) {}
            }
            userState.delete(ctx.chat.id);
            return ctx.reply("✅ اكتمل النشر.");
        }
    }

    // الأوامر الرئيسية
    switch (text) {
        case "نجم":
            ctx.reply(`🌟 *أوامر نجم الإبداع:*
1️⃣ نجم نشر - إعلان (3 خطوات)
2️⃣ نجم احصا - إحصائيات التطبيقات
3️⃣ نجم بنج - فحص السيرفر`);
            break;
        case "نجم نشر":
            userState.set(ctx.chat.id, { step: "waiting_link" });
            ctx.reply("🔗 *خطوة 1/3*\nأرسل *رابط التطبيق* الآن:");
            break;
        case "نجم احصا":
            const snap = await db.collection('users').get();
            let stats = "📊 *الإحصائيات حسب التطبيق:*\n";
            let counts = {};
            snap.docs.forEach(d => {
                let name = d.data().appName;
                counts[name] = (counts[name] || 0) + 1;
            });
            for (let app in counts) stats += `\n📱 ${app}: ${counts[app]}`;
            ctx.reply(stats);
            break;
        case "نجم بنج":
            ctx.reply(`🏓 الاستجابة سريعة والسيرفر مستقر.`);
            break;
    }
});

app.get("/ping", (req, res) => res.send("💓 SUCCESS"));
bot.launch();
app.listen(process.env.PORT || 10000);
