const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
require("dotenv").config();
const { Resend } = require("resend");
const admin = require("firebase-admin");
const serverless = require("serverless-http");

// --- Load Service Account from Environment Variable ---
let serviceAccount;
// It's crucial to wrap this in a try-catch as invalid base64 or JSON will throw an error.
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const decodedServiceAccount = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT,
      "base64"
    ).toString("utf-8");
    serviceAccount = JSON.parse(decodedServiceAccount);
  } catch (e) {
    console.error("Error parsing Firebase Service Account JSON:", e);
    // If Firebase can't be configured, the app can't run. We should not proceed.
    serviceAccount = null;
  }
} else {
  console.error("FIREBASE_SERVICE_ACCOUNT environment variable not set.");
  serviceAccount = null;
}

// --- Initialize Firebase Admin SDK ---
// Check if the app is already initialized and if the service account is valid.
if (!admin.apps.length && serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (error) {
    console.error("Error initializing Firebase Admin SDK:", error);
  }
}

// --- Get Firestore Instance ---
// This will only be valid if the initialization above was successful.
const db = admin.apps.length ? admin.firestore() : null;

// --- Initialize Express App ---
const app = express();
const router = express.Router();

router.use(express.json());

// --- Load Environment Variables ---
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  RESEND_API_KEY,
  FROM_EMAIL,
  ADMIN_EMAIL,
  PAYPAL_BASE_URL,
} = process.env;

// --- Initialize Resend ---
// Ensure the API key exists before initializing
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
if (!resend) {
  console.error(
    "RESEND_API_KEY is not set. Email functionality will be disabled."
  );
}

// --- PayPal Configuration ---
const base = PAYPAL_BASE_URL; // Using Sandbox or Production URL from .env

// --- PayPal Access Token Generation ---
const generateAccessToken = async () => {
  try {
    // Ensure PayPal credentials are provided
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      throw new Error("PayPal client ID or secret is not configured.");
    }
    const auth = Buffer.from(
      `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
    ).toString("base64");
    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      body: "grant_type=client_credentials",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Failed to get PayPal token: ${response.statusText} - ${errorBody}`
      );
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error("Failed to generate Access Token:", error);
    throw new Error("Failed to generate PayPal Access Token.");
  }
};

// --- Internal Function to Create License in Firestore ---
const createLicense = async (licenseData) => {
  if (!db) {
    console.error("Firestore is not available. Cannot create license.");
    return { success: false, error: "Database connection not established." };
  }
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

// --- Middleware to check for DB connection ---
const checkDbConnection = (req, res, next) => {
  if (!db) {
    return res
      .status(503)
      .json({ message: "Service Unavailable: Database not connected." });
  }
  next();
};

// --- API Endpoints ---

/**
 * NEW: Endpoint to provide public configurations like the PayPal Client ID
 * @api {get} /config
 * @description Get public configuration variables.
 */
router.get("/config", (req, res) => {
  if (PAYPAL_CLIENT_ID) {
    res.status(200).json({ paypalClientId: PAYPAL_CLIENT_ID });
  } else {
    // This error will be logged in Netlify functions, not shown to the user.
    console.error(
      "PAYPAL_CLIENT_ID environment variable is not set on the server."
    );
    // Send a generic error to the client.
    res
      .status(500)
      .json({ error: "Payment provider configuration is missing." });
  }
});

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
    res
      .status(503)
      .json({ message: "Service Unavailable: Database connection failed." });
  }
});

/**
 * @api {post} /license
 * @description Creates and stores a new license record in the database.
 */
router.post("/license", checkDbConnection, async (req, res) => {
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
    };

    const result = await createLicense(licenseData);

    if (result.success) {
      res
        .status(201)
        .json({ message: "License created successfully", id: result.id });
    } else {
      res
        .status(500)
        .json({ message: "Error creating license.", error: result.error });
    }
  } catch (error) {
    console.error("Error in /license endpoint:", error);
    res
      .status(500)
      .json({ message: "Internal server error.", error: error.message });
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
router.post("/capture-order", checkDbConnection, async (req, res) => {
  try {
    const { orderID, domain, email } = req.body;

    if (!orderID || !domain || !email) {
      return res.status(400).json({
        error: "Missing required fields: orderID, domain, and email.",
      });
    }

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
      const generatedKey =
        "PRO-" +
        [...Array(4)]
          .map(() => Math.random().toString(36).slice(2, 7).toUpperCase())
          .join("-");
      const transactionId =
        capturedData.purchase_units[0].payments.captures[0].id;

      const licenseResult = await createLicense({
        license: generatedKey,
        domain: domain,
        email: email,
        amount: 49.0,
        transactionId: transactionId,
      });

      if (!licenseResult.success) {
        console.error(
          `CRITICAL: Payment successful (Transaction ID: ${transactionId}), but failed to save license to Firestore for domain ${domain}. Manual intervention required.`
        );
        // Even if DB write fails, we should still try to email the admin
      }

      // Send emails only if Resend is configured
      if (resend) {
        try {
          // Email to customer
          await resend.emails.send({
            from: `"WhatsApp Pro Chat" <${FROM_EMAIL}>`,
            to: [email],
            subject: "Your WhatsApp Pro Chat License - Order Confirmation",
            html: `<h1>Thank you for your purchase!</h1><p>Your license key and order details are below.</p><ul><li><strong>Order ID:</strong> ${
              licenseResult.id || "N/A"
            }</li><li><strong>Domain:</strong> ${domain}</li><li><strong>License Key:</strong> <code>${generatedKey}</code></li><li><strong>Transaction ID:</strong> ${transactionId}</li></ul><p>Thank you for choosing WhatsApp Pro Chat.</p>`,
          });

          // Email to admin
          await resend.emails.send({
            from: `"Sales Notification" <${FROM_EMAIL}>`,
            to: [ADMIN_EMAIL],
            subject: `New Sale! License for ${domain}`,
            html: `<h1>New Sale!</h1><p>A new license has been generated:</p><ul><li><strong>Order ID:</strong> ${
              licenseResult.id || "N/A"
            }</li><li><strong>Domain:</strong> ${domain}</li><li><strong>Customer Email:</strong> ${email}</li><li><strong>License Key:</strong> <code>${generatedKey}</code></li><li><strong>PayPal Transaction ID:</strong> ${transactionId}</li></ul><p style="color: ${
              licenseResult.success ? "green" : "red"
            };"><strong>Firestore Status:</strong> ${
              licenseResult.success ? "Saved successfully." : "SAVE FAILED."
            }</p>`,
          });
        } catch (emailError) {
          console.error(
            `CRITICAL: Payment successful (Transaction ID: ${transactionId}), but Resend emails failed:`,
            emailError
          );
        }
      }

      res
        .status(200)
        .json({ licenseKey: generatedKey, transactionId: transactionId });
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

  if (!resend) {
    return res
      .status(503)
      .json({ message: "Service Unavailable: Email service not configured." });
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
router.get("/verify", checkDbConnection, async (req, res) => {
  try {
    // Destructure both key and domain from the query string
    const { key, domain } = req.query;

    // Validate that both key and domain are provided
    if (!key || !domain) {
      return res
        .status(400)
        .json({ message: "Key and domain are required for verification." });
    }

    const licensesRef = db.collection("licenses");
    // Chain 'where' clauses to query for a document that matches both fields
    const snapshot = await licensesRef
      .where("license", "==", key)
      .where("domain", "==", domain)
      .limit(1)
      .get();

    // If no document matches both the key and domain
    if (snapshot.empty) {
      return res
        .status(404)
        .json({ verified: false, message: "Invalid license key or domain." });
    }

    // If a match is found, prepare the response
    let responseData;
    snapshot.forEach((doc) => {
      const fullData = doc.data();
      // Return non-sensitive data, confirming verification
      responseData = {
        license: fullData.license,
        domain: fullData.domain,
        verified: true,
      };
    });

    // Send the successful response
    res.status(200).json(responseData);
  } catch (error) {
    console.error("Error in /verify endpoint:", error);
    res
      .status(500)
      .json({ message: "Error verifying license.", error: error.message });
  }
});

// Mount the router to the application's base API path
app.use("/api", router);

// Use module.exports.handler for CommonJS compatibility with serverless-http
module.exports.handler = serverless(app);