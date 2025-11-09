import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import Stripe from "stripe";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import SibApiV3Sdk from "sib-api-v3-sdk";

dotenv.config();

/* ------------------ APP SETUP ------------------ */
const app = express();
const upload = multer({ dest: "uploads/" });
const port = process.env.PORT || 10000;

/* ------------------ THIRD-PARTY CLIENTS ------------------ */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Brevo email setup
const brevoClient = SibApiV3Sdk.ApiClient.instance;
brevoClient.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
const brevo = new SibApiV3Sdk.TransactionalEmailsApi();

/* ------------------ CORS (FINAL FIX) ------------------ */
const allowedOrigins = [
  "https://lectureai-saas-websi-wchx.bolt.host",
  "https://lectureai-saas-websi-a50f.bolt.host",
  "http://localhost:5173",
];

// Manual CORS + OPTIONS handler
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "50mb" }));

/* ------------------ STRIPE WEBHOOK ------------------ */
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const { email, metadata } = session;
        const plan_type = metadata?.plan_type || "unknown";
        const user_id = metadata?.user_id || null;
        const stripe_customer_id = session.customer;
        const subscription_status = "active";

        await supabase.from("user_subscriptions").upsert({
          user_id,
          email,
          plan_type,
          stripe_customer_id,
          subscription_status,
        });

        console.log(`💾 Stored subscription for user ${user_id}`);
      } else {
        console.log("Unhandled Stripe event:", event.type);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("⚠️ Stripe webhook error:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

/* ------------------ BACKBLAZE AUTH ------------------ */
let authData = null;
async function authorizeB2() {
  const auth = Buffer.from(
    `${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`
  ).toString("base64");

  const res = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    headers: { Authorization: `Basic ${auth}` },
  });
  authData = await res.json();
  console.log("✅ Authorized with Backblaze");
}
await authorizeB2();

/* ------------------ FILE UPLOAD ------------------ */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const getUrl = await fetch(`${authData.apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: "POST",
      headers: {
        Authorization: authData.authorizationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bucketId: process.env.B2_BUCKET_ID }),
    });
    const uploadUrl = await getUrl.json();

    const data = fs.readFileSync(file.path);
    const uploadRes = await fetch(uploadUrl.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: uploadUrl.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(file.originalname),
        "Content-Type": "b2/x-auto",
        "X-Bz-Content-Sha1": "do_not_verify",
      },
      body: data,
    });

    const result = await uploadRes.json();
    fs.unlinkSync(file.path);

    res.json({ message: "✅ File uploaded successfully", result });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ SIGNED DOWNLOAD ------------------ */
app.get("/signed-download", async (req, res) => {
  try {
    const fileName = req.query.fileName;
    const auth = Buffer.from(
      `${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`
    ).toString("base64");

    const authRes = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      headers: { Authorization: `Basic ${auth}` },
    });
    const data = await authRes.json();

    const downloadUrl = `${data.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}`;
    const headers = data.authorizationToken;

    res.json({
      message: "✅ Signed URL generated successfully",
      downloadUrl,
      authorizationHeader: headers,
    });
  } catch (err) {
    console.error("❌ Signed download error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ ANALYZE ------------------ */
app.post("/analyze", async (req, res) => {
  try {
    const { fileName, email } = req.body;
    console.log(`🎧 Starting analysis for ${fileName} → ${email}`);

    const signed = await fetch(
      `${process.env.SERVER_URL || `http://localhost:${port}`}/signed-download?fileName=${encodeURIComponent(fileName)}`
    );
    const { downloadUrl, authorizationHeader } = await signed.json();

    const audioRes = await fetch(downloadUrl, {
      headers: { Authorization: authorizationHeader },
    });
    const audioBuffer = await audioRes.arrayBuffer();

    console.log(`Downloaded audio bytes: ${audioBuffer.byteLength}`);
    console.log("🧠 Transcribing lecture...");

    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], "lecture.mp3"),
      model: "gpt-4o-mini-transcribe",
    });

    const text = transcription.text || "";
    console.log(`Transcription length: ${text.length}`);

    console.log("🪄 Creating notes with GPT-4...");
    const notesPrompt = `Summarize the following lecture into well-structured study notes with headings and bullet points:\n\n${text}`;
    const summary = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: notesPrompt }],
    });
    const notes = summary.choices[0].message.content;

    console.log("📧 Sending email via Brevo...");
    await brevo.sendTransacEmail({
      sender: { email: "no-reply@lectureai.app", name: "LectureAI" },
      to: [{ email }],
      subject: `Lecture Notes: ${fileName}`,
      htmlContent: `<h2>Your Lecture Notes</h2><pre>${notes}</pre>`,
    });

    console.log("✅ Done — notes sent!");
    res.json({
      message: "✅ Analysis complete and notes emailed",
      fileName,
      email,
      sample: notes.slice(0, 300) + "...",
    });
  } catch (err) {
    console.error("❌ Analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ STRIPE CHECKOUT ------------------ */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan_type, user_id, email } = req.body;
    const priceId =
      plan_type === "subscription"
        ? process.env.PRICE_ID_SUBSCRIPTION
        : process.env.PRICE_ID_SINGLE;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,
      mode: plan_type === "subscription" ? "subscription" : "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: { user_id, plan_type },
    });

    console.log(`💰 Created checkout for ${email} (${plan_type})`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ BILLING PORTAL ------------------ */
app.post("/create-portal-session", async (req, res) => {
  try {
    const { customer_id, return_url } = req.body;
    if (!customer_id) return res.status(400).json({ error: "Missing customer_id" });

    const portal = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url:
        return_url || process.env.SUCCESS_URL || "https://lectureai.bolt.host/success",
    });

    res.json({ url: portal.url });
  } catch (err) {
    console.error("❌ Billing portal error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ START SERVER ------------------ */
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
