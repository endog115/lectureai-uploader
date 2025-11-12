/* ------------------------------------------------------------
   LectureAI Uploader + Stripe + Backblaze Server (Final v4)
   Author: Gunner Endicott
------------------------------------------------------------- */

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import Stripe from "stripe";
import bodyParser from "body-parser";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

/* ---------- CORE CONFIG ---------- */
const app = express();
const PORT = process.env.PORT || 10000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ dest: "uploads/" });

/* ---------- MIDDLEWARE ---------- */
// Enable CORS for your Bolt sites
app.use(
  cors({
    origin: [
      "https://lectureai.bolt.host",
      "https://lectureai-saas-websi-wchx.bolt.host",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Parse JSON normally, but keep webhook raw
app.use((req, res, next) => {
  if (req.originalUrl === "/stripe/webhook") {
    next();
  } else {
    express.json({ limit: "50mb" })(req, res, next);
  }
});

/* ---------- BASE ROUTE ---------- */
app.get("/", (req, res) => {
  res.send("✅ LectureAI Uploader backend is running successfully.");
});

/* ============================================================
   1️⃣  STRIPE CHECKOUT (Subscription + One-time)
============================================================ */
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("📩 Incoming checkout request:", req.body);
    const { plan_type, email, user_id } = req.body;
    let priceId;
    let mode;

    if (plan_type === "subscription") {
      priceId = process.env.PRICE_ID_SUBSCRIPTION;
      mode = "subscription";
    } else if (plan_type === "single") {
      priceId = process.env.PRICE_ID_SINGLE;
      mode = "payment";
    }

    if (!priceId) {
      console.error("❌ Missing or invalid plan_type:", plan_type);
      return res.status(400).json({ error: "Invalid plan_type or missing priceId" });
    }

    const session = await stripe.checkout.sessions.create({
      mode,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      metadata: {
        plan_type,
        user_id: user_id || "none",
      },
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
    });

    console.log(`✅ Stripe checkout session created: ${session.id}`);
    res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Failed to start checkout:", error);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

/* ============================================================
   2️⃣  STRIPE WEBHOOK HANDLER
============================================================ */
app.post(
  "/stripe/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️ Webhook verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const { email, metadata, customer } = session;

        await supabase.from("user_subscriptions").upsert({
          user_id: metadata?.user_id || null,
          email,
          plan_type: metadata?.plan_type || "unknown",
          stripe_customer_id: customer,
          subscription_status: "active",
        });

        console.log(`💾 Subscription recorded for ${email}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error("❌ Webhook handling error:", error);
      res.status(500).send("Webhook handler failed");
    }
  }
);

/* ============================================================
   3️⃣  BACKBLAZE FILE UPLOAD
============================================================ */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const auth = Buffer.from(
      `${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`
    ).toString("base64");

    const authRes = await fetch(
      "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const authData = await authRes.json();

    const uploadUrlRes = await fetch(
      `${authData.apiUrl}/b2api/v2/b2_get_upload_url`,
      {
        method: "POST",
        headers: {
          Authorization: authData.authorizationToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bucketId: process.env.B2_BUCKET_ID }),
      }
    );
    const uploadUrlData = await uploadUrlRes.json();

    const uploadRes = await fetch(uploadUrlData.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: uploadUrlData.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(file.originalname),
        "Content-Type": "b2/x-auto",
        "X-Bz-Content-Sha1": "do_not_verify",
      },
      body: fs.createReadStream(file.path),
    });

    const uploadResult = await uploadRes.json();
    console.log("✅ File uploaded to Backblaze:", uploadResult.fileName);
    res.json({ message: "Upload successful", uploadResult });
  } catch (err) {
    console.error("❌ Upload failed:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ============================================================
   4️⃣  SERVER START
============================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
