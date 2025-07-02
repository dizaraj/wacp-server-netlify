// netlify/functions/api.js
import express from "express";
import fetch from "node-fetch";
import "dotenv/config";
import { Resend } from "resend";
import admin from "firebase-admin";
import serverless from "serverless-http";
import path from "path";

// --- Load Service Account from Environment Variable ---
// On Netlify, the service account JSON is stored as a base64 encoded environment variable.
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString(
        "utf-8"
      )
    );
  } catch (e) {
    console.error("Error parsing Firebase Service Account JSON:", e);
  }
} else {
  console.error("FIREBASE_SERVICE_ACCOUNT environment variable not set.");
}

// --- Initialize Firebase Admin SDK ---
// Check if the app is already initialized to prevent errors during hot-reloading.
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (error) {
    console.error("Error initializing Firebase Admin SDK:", error);
  }
}
const db = admin.firestore();

// --- Initialize Express App ---
const app = express();
// We use a router to keep the code clean and modular.
const router = express.Router();

router.use(express.json());

// --- Load Environment Variables ---
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  RESEND_API_KEY,
  FROM_EMAIL,
  ADMIN_EMAIL,
} = process.env;

// --- Initialize Resend ---
const resend = new Resend(RESEND_API_KEY);

// --- PayPal Configuration ---
const base = "https://api-m.sandbox.paypal.com"; // Using Sandbox for testing

// --- PayPal Access Token Generation ---
const generateAccessToken = async () => {
  try {
    const auth = Buffer.from(
      `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
    ).toString("base64");
    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      body: "grant_type=client_credentials",
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });
    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error("Failed to generate Access Token:", error);
    // In a serverless function, it's better to throw to indicate a critical failure
    throw new Error("Failed to generate PayPal Access Token.");
  }
};

// --- Internal Function to Create License in Firestore ---
const createLicense = async (licenseData) => {
  try {
    const docRef = await db.collection("licenses").add({
      ...licenseData,
      createdAt: new Date().toISOString(),
    });
    console.log("License created successfully with ID:", docRef.id);
    return { success: true, id: docRef.id };
  } catch (error) {
    console.error("Error creating license in Firestore:", error);
    return { success: false, error: error.message };
  }
};

// --- API Endpoints ---

/**
 * @api {get} /status
 * @description Get the connection status of the server and database.
 */
router.get("/status", (req, res) => {
  if (db) {
    res
      .status(200)
      .json({ message: "Server is running and database is connected." });
  } else {
    res.status(500).json({ message: "Database connection failed." });
  }
});

/**
 * @api {post} /license
 * @description Creates and stores a new license record in the database.
 */
router.post("/license", async (req, res) => {
  try {
    const { license, domain, email, amount } = req.body;

    // Basic validation
    if (!license || !domain || !email || amount === undefined) {
      return res
        .status(400)
        .json({ message: "Invalid input. All fields are required." });
    }

    const licenseData = {
      license,
      domain,
      email,
      amount,
      createdAt: new Date().toISOString(), // Add a timestamp
    };

    // Add a new document to the 'licenses' collection
    const docRef = await db.collection("licenses").add(licenseData);

    res
      .status(201)
      .json({ message: "License created successfully", id: docRef.id });
  } catch (error) {
    console.error("Error in /license endpoint:", error);
    res
      .status(500)
      .json({ message: "Error creating license.", error: error.message });
  }
});

// 1. PayPal: Create Order
router.post("/create-order", async (req, res) => {
  try {
    const accessToken = await generateAccessToken();
    const url = `${base}/v2/checkout/orders`;
    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: "WhatsApp Pro Chat - Lifetime License",
          amount: {
            currency_code: "USD",
            value: "49.00",
          },
        },
      ],
    };

    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      method: "POST",
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to create order." });
  }
});

// 2. PayPal: Capture Order & Generate License
router.post("/capture-order", async (req, res) => {
  try {
    const { orderID, domain, email } = req.body;
    const accessToken = await generateAccessToken();
    const url = `${base}/v2/checkout/orders/${orderID}/capture`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const capturedData = await response.json();

    if (capturedData.status === "COMPLETED") {
      const generatedKey = `WAPRO-${domain
        .substring(0, 4)
        .toUpperCase()}-${Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase()}-${new Date().getFullYear()}`;
      const transactionId = capturedData.id;

      const licenseResult = await createLicense({
        license: generatedKey,
        domain: domain,
        email: email,
        amount: 49.0,
        transactionId: transactionId,
      });

      if (!licenseResult.success) {
        console.error(
          "CRITICAL: Payment successful, but failed to save license to Firestore."
        );
      }

      try {
        await resend.emails.send({
          from: `"WhatsApp Pro Chat" <${FROM_EMAIL}>`,
          to: [email],
          subject: "Your WhatsApp Pro Chat License - Order Confirmation",
          html: `<h1>Thank you for your purchase!</h1><p>Your license key and order details are below.</p><ul><li><strong>Order ID:</strong> ${licenseResult.id}</li><li><strong>Domain:</strong> ${domain}</li><li><strong>License Key:</strong> <code>${generatedKey}</code></li><li><strong>Transaction ID:</strong> ${transactionId}</li></ul><p>Thank you for choosing WhatsApp Pro Chat.</p>`,
        });

        await resend.emails.send({
          from: `"Sales Notification" <${FROM_EMAIL}>`,
          to: [ADMIN_EMAIL],
          subject: `New Sale! License for ${domain}`,
          html: `<h1>New Sale!</h1><p>A new license has been generated:</p><ul><li><strong>Order ID:</strong> ${licenseResult.id}</li><li><strong>Domain:</strong> ${domain}</li><li><strong>Customer Email:</strong> ${email}</li><li><strong>License Key:</strong> <code>${generatedKey}</code></li><li><strong>PayPal Transaction ID:</strong> ${transactionId}</li></ul>`,
        });
      } catch (emailError) {
        console.error(
          "CRITICAL: Payment successful, but Resend emails failed:",
          emailError
        );
      }

      res.status(200).json({ licenseKey: generatedKey });
    } else {
      res
        .status(400)
        .json({ error: "Payment not completed.", details: capturedData });
    }
  } catch (error) {
    console.error("Failed to capture order:", error);
    res.status(500).json({ error: "Failed to capture order." });
  }
});

// 3. Contact Form: Send Email
router.post("/send-email", async (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    await resend.emails.send({
      from: `"Contact Form" <${FROM_EMAIL}>`,
      to: [ADMIN_EMAIL],
      reply_to: email,
      subject: `New Contact Form Submission: ${subject}`,
      html: `<p>You have a new contact form submission from:</p><ul><li><strong>Name:</strong> ${name}</li><li><strong>Email:</strong> ${email}</li></ul><p><strong>Message:</strong></p><p>${message}</p>`,
    });
    res.status(200).json({ message: "Thank you! Your message has been sent." });
  } catch (error) {
    console.error("Error sending email via Resend:", error);
    res.status(500).json({
      message: "Sorry, something went wrong. Please try again later.",
    });
  }
});

// 4. License Verification
router.get("/verify", async (req, res) => {
  try {
    const { domain } = req.query;

    if (!domain) {
      return res
        .status(400)
        .json({ message: "Domain is required for verification." });
    }

    const licensesRef = db.collection("licenses");
    const snapshot = await licensesRef
      .where("domain", "==", domain)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res
        .status(404)
        .json({ message: "No license found for the specified domain." });
    }

    let responseData;
    snapshot.forEach((doc) => {
      const fullData = doc.data();
      responseData = {
        license: fullData.license,
        domain: fullData.domain,
      };
    });

    res.status(200).json(responseData);
  } catch (error) {
    console.error("Error in /verify endpoint:", error);
    res
      .status(500)
      .json({ message: "Error verifying license.", error: error.message });
  }
});

// All your API routes are attached to the router.
// We now mount the router to the path that Netlify will use.
app.use("/.netlify/functions/api", router);

// This is the magic that makes Express work with Netlify Functions.
export const handler = serverless(app);