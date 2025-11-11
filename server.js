// ======================================
// LectureAI Uploader & Payment Server
// ======================================

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import Stripe from "stripe";
import fetch from "node-fetch";
import fs from "fs";

// Load environment variables
dotenv.config();

// ======================================
// App + Middleware Setup
// ======================================
const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Allow CORS between Render + Bolt + Localhost
const allowedOrigins = [
  "https://lectureai-saas-websi-wchx.bolt.host",
  "https://lectureai-uploader.onrender.com",
  "http://localhost:3000",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======================================
// File Upload (Local / Backblaze placeholder)
// ======================================
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    console.log("✅ File uploaded:", file.originalname);
    res.json({ success: true, fileName: file.originalname });
  } catch (err) {
    console.error("❌ Upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ======================================
// Stripe Checkout Session
// ======================================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, email } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: "Missing priceId" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode:
        priceId === process.env.STRIPE_ONE_TIME_PRICE_ID
          ? "payment"
          : "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,

      // ✅ Redirect to live Bolt site after checkout
      success_url:
        "https://lectureai-saas-websi-wchx.bolt.host/?checkout=success",
      cancel_url:
        "https://lectureai-saas-websi-wchx.bolt.host/?checkout=cancel",

      // ✅ Show “Return to website” button on Stripe’s confirmation screen
      ui_mode: "hosted",
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Error creating checkout session:", error);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

// ======================================
// Stripe Webhook (optional)
// ======================================
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log(`✅ Payment successful for ${session.customer_email}`);
  }

  res.sendStatus(200);
});

// ======================================
// Health Check / Root Route
// ======================================
app.get("/", (req, res) => {
  res.send("✅ LectureAI uploader + payment server is running");
});

// ======================================
// Start Server
// ======================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
