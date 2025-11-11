/* ------------------ IMPORTS ------------------ */
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import Stripe from "stripe";
import dotenv from "dotenv";
import OpenAI from "openai";
import bodyParser from "body-parser";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import SibApiV3Sdk from "sib-api-v3-sdk";

/* ------------------ CONFIG ------------------ */
dotenv.config();
const app = express();
const upload = multer({ dest: "uploads/" });
const port = process.env.PORT || 3000;

/* ------------------ GLOBAL CLIENTS ------------------ */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const brevoClient = SibApiV3Sdk.ApiClient.instance;
brevoClient.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
const brevo = new SibApiV3Sdk.TransactionalEmailsApi();

/* ------------------ CORS (CRITICAL FIX) ------------------ */
app.use(
  cors({
    origin: [
      "https://lectureai-saas-websi-wchx.bolt.host", // ✅ Your Bolt frontend
      "https://lectureai-uploader.onrender.com",     // ✅ Your Render backend
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 204,
  })
);

// ✅ Express 5+ compatible wildcard fix
app.options(/.*/, cors());

/* ------------------ MIDDLEWARE ------------------ */
app.use(bodyParser.json({ limit: "50mb" }));
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
      }

      res.json({ received: true });
    } catch (err) {
      console.error("⚠️ Webhook verification failed:", err.message);
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

/* ------------------ UPLOAD ------------------ */
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

/* ------------------ STRIPE CHECKOUT ------------------ */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan_type, user_id, email } = req.body;
    console.log("🎯 Incoming checkout request:", { plan_type, user_id, email });

    const priceId =
      plan_type === "subscription"
        ? process.env.PRICE_ID_SUBSCRIPTION
        : process.env.PRICE_ID_SINGLE;

    if (!priceId) {
      throw new Error("Missing Stripe price ID in environment");
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,
      mode: plan_type === "subscription" ? "subscription" : "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: { user_id, plan_type },
    });

    console.log("✅ Stripe session created:", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout error:", err.message);
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
    console.error("❌ Portal session error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ SERVER START ------------------ */
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
