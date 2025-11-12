/* ----------------------------------------------------
   LectureAI Uploader + Payment Server (Final Build)
   Author: Gunner Endicott
   ---------------------------------------------------- */

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import Stripe from "stripe";
import bodyParser from "body-parser";
import { createClient } from "@supabase/supabase-js";
import SibApiV3Sdk from "sib-api-v3-sdk";

dotenv.config();

/* ---------- CONFIG ---------- */
const app = express();
const PORT = process.env.PORT || 10000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ dest: "uploads/" });

/* ---------- MIDDLEWARE ---------- */

// Enable CORS for your Bolt site
app.use(
  cors({
    origin: [
      "https://lectureai-saas-websi-wchx.bolt.host",
      "https://lectureai.bolt.host",
    ],
    credentials: true,
  })
);

// Parse JSON for all routes except the Stripe webhook (which must remain raw)
app.use((req, res, next) => {
  if (req.originalUrl === "/stripe/webhook") {
    next();
  } else {
    express.json({ limit: "50mb" })(req, res, next);
  }
});

/* ---------- ROUTES ---------- */

// Root test
app.get("/", (req, res) => {
  res.send("✅ LectureAI Uploader Server is running!");
});

/* -----------------------------
   STRIPE CHECKOUT
----------------------------- */

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, email, plan_type, user_id } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      metadata: {
        plan_type: plan_type || "unknown",
        user_id: user_id || "none",
      },
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
    });

    console.log("✅ Stripe Checkout Session created");
    res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Failed to start checkout:", error.message);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

/* -----------------------------
   STRIPE WEBHOOK
----------------------------- */

app.post(
  "/stripe/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      switch (event.type) {
        case "checkout.session.completed": {
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

          console.log(`💾 Stored subscription for ${email}`);
          break;
        }
        default:
          console.log(`Unhandled Stripe event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("⚠️ Webhook signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

/* -----------------------------
   FILE UPLOAD → BACKBLAZE B2
----------------------------- */

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
      body: require("fs").createReadStream(file.path),
    });

    const uploadResult = await uploadRes.json();
    console.log("✅ Uploaded file:", uploadResult.fileName);
    res.json({ message: "Upload successful", uploadResult });
  } catch (err) {
    console.error("❌ Upload failed:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* -----------------------------
   SERVER START
----------------------------- */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

