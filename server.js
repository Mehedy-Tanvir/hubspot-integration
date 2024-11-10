import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import session from "express-session";
import fetch from "node-fetch";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

// Serve static files
app.use(express.static("public"));

// HubSpot OAuth configuration
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const HUBSPOT_REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;
const HUBSPOT_SCOPES =
  "oauth crm.objects.contacts.read crm.objects.contacts.write";

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.get("/auth", (req, res) => {
  const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${HUBSPOT_CLIENT_ID}&redirect_uri=${HUBSPOT_REDIRECT_URI}&scope=${HUBSPOT_SCOPES}`;
  res.redirect(authUrl);
});

app.get("/oauth-callback", async (req, res) => {
  const { code } = req.query;

  try {
    const tokenResponse = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: HUBSPOT_CLIENT_ID,
        client_secret: HUBSPOT_CLIENT_SECRET,
        redirect_uri: HUBSPOT_REDIRECT_URI,
        code: code,
      }),
    });

    const { access_token, refresh_token } = await tokenResponse.json();
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;

    res.redirect("/");
  } catch (error) {
    console.error("Error during OAuth:", error);
    res.status(500).send("Authentication failed");
  }
});

app.post("/submit-form", async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).send("Not authenticated");
  }

  try {
    const response = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          properties: req.body,
        }),
      }
    );

    if (!response.ok) {
      throw new Error("Failed to submit to HubSpot");
    }

    const data = await response.json();
    res.json({ success: true, data });
  } catch (error) {
    console.error("Error submitting to HubSpot:", error);
    res.status(500).json({ success: false, error: "Failed to submit form" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});

console.log(
  "Server code executed. Make sure to set up your environment variables and run the server."
);
