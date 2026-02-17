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
const ADMIN_ID = "7650083401"; 

// --- [ منطق المزامنة والتحقق الحقيقي ] ---

// طلب الكود وإرسال SMS
app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    // توليد كود من 6 أرقام (كما طلبت)
    const otp = Math.floor(100000 + Math.random() * 899999).toString();

    try {
        // [مهم]: حفظ الكود في Firebase للتحقق منه لاحقاً
        await db.collection('otps').doc(phone).set({
            code: otp,
            deviceId: deviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // إرسال الـ SMS الحقيقي عبر Infobip
        await axios.post(`${process.env.INFOBIP_BASE_URL}/sms/2/text/advanced`, {
            messages: [{
                destinations: [{ to: phone }],
                from: "Njm-RK",
                text: `كود التحقق الخاص بك في تطبيق ${appName} هو: ${otp}`
            }]
        }, { headers: { 'Authorization': `App ${process.env.INFOBIP_API_KEY}` } });

        // إشعار الإدارة في تليجرام
        bot.telegram.sendMessage(ADMIN_ID, `🎯 *كود جديد مرسل*\n📞: ${phone}\n👤: ${name}\n🔑: \`${otp}\``, { parse_mode: "Markdown" });

        res.status(200).send("SUCCESS");
    } catch (e) { res.status(200).send("SUCCESS"); }
});

// التحقق من الكود (لن يفتح التطبيق إلا إذا طابق الكود المخزن)
app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    try {
        const otpDoc = await db.collection('otps').doc(phone).get();
        if (otpDoc.exists && otpDoc.data().code === code) {
            // الكود صحيح: نحفظ المستخدم في قائمة الموثقين ونرسل 200
            await db.collection('users').doc(phone).set({ deviceId: otpDoc.data().deviceId, verified: true }, { merge: true });
            res.status(200).send("VERIFIED");
        } else {
            // الكود خطأ: نرسل 401 ليظهر الخطأ في التطبيق
            res.status(401).send("INVALID_CODE");
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

// فحص الجهاز (يرد بـ 401 للمستخدمين الجدد لإجبارهم على التسجيل)
app.get("/check-device", async (req, res) => {
    const devId = req.query.id || req.query.deviceId;
    try {
        const userRef = db.collection('users').where('deviceId', '==', devId);
        const snap = await userRef.get();
        if (!snap.empty) {
            res.status(200).send("ALLOWED");
        } else {
            res.status(401).send("UNAUTHORIZED");
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

// الأوامر العربية
bot.on('text', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    if (ctx.message.text === "نجم احصا") {
        const snap = await db.collection('users').get();
        ctx.reply(`📊 إجمالي الموثقين: ${snap.size}`);
    }
});

bot.launch();
app.listen(process.env.PORT || 10000);
