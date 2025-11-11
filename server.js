// ================================
// LectureAI Uploader Server
// ================================
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import Stripe from "stripe";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Load .env variables
dotenv.config();

// ================================
// Setup
// ================================
const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Enable JSON + CORS for your Bolt frontend
const allowedOrigins = [
  "https://lectureai-saas-websi-wchx.bolt.host",
  "https://lectureai-uploader.onrender.com",
  "http://localhost:3000"
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// ================================
// File Upload Setup (Backblaze placeholder)
// ================================
const upload = multer({ dest: "uploads/" });

// ================================
// Stripe Checkout Endpoint
// ================================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, email } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: "Missing priceId" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: priceId === process.env.STRIPE_ONE_TIME_PRICE_ID ? "payment" : "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      // ✅ After payment, go back to your site
      success_url: "https://lectureai-saas-websi-wchx.bolt.host/?checkout=success",
      cancel_url: "https://lectureai-saas-websi-wchx.bolt.host/?checkout=cancel",
      // ✅ Allow users to go back to site from checkout page
      ui_mode: "hosted",
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Error creating checkout session:", error);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

// ================================
// Stripe Webhook (optional - if configured)
// ================================
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

  // Handle successful payments
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log(`✅ Payment received for ${session.customer_email}`);
  }

  res.sendStatus(200);
});

// ================================
// File Upload Route (example placeholder)
// ================================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    console.log("✅ File uploaded:", filePath);
    res.json({ success: true, fileName: req.file.originalname });
  } catch (err) {
    console.error("❌ Upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ================================
// Health Check / Root
// ================================
app.get("/", (req, res) => {
  res.send("✅ LectureAI server is running");
});

// ================================
// Start Server
// ================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
