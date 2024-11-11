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
  "oauth crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write";

// Helper function to refresh token
async function refreshToken(refreshToken) {
  const response = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh token");
  }

  return await response.json();
}

// Helper function to create a property
async function createProperty(propertyName, accessToken) {
  const propertyDetails = {
    name: propertyName,
    label: propertyName.charAt(0).toUpperCase() + propertyName.slice(1),
    type: "string",
    fieldType: "text",
    groupName: "contactinformation",
  };

  const createPropertyResponse = await fetch(
    "https://api.hubapi.com/properties/v1/contacts/properties",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(propertyDetails),
    }
  );

  if (!createPropertyResponse.ok) {
    console.error(
      "Failed to create property:",
      await createPropertyResponse.text()
    );
    throw new Error(`Failed to create property ${propertyName}`);
  }

  console.log(`Property ${propertyName} created successfully.`);
}

// Helper function to select properties to show
async function selectPropertiesToShow(accessToken) {
  const propertiesResponse = await fetch(
    "https://api.hubapi.com/properties/v1/contacts/properties",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!propertiesResponse.ok) {
    throw new Error("Failed to fetch HubSpot properties");
  }

  const propertiesData = await propertiesResponse.json();

  const selectedProperties = propertiesData
    .filter((prop) => prop.groupName === "contactinformation")
    .map((prop) => ({
      name: prop.name,
      label: prop.label,
      type: prop.type,
      fieldType: prop.fieldType,
    }));

  return selectedProperties;
}

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
  // console.log("form data", req.body);

  try {
    // Step 1: Fetch HubSpot contact properties
    const propertiesResponse = await fetch(
      "https://api.hubapi.com/properties/v1/contacts/properties",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${req.session.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!propertiesResponse.ok) {
      if (propertiesResponse.status === 401) {
        // Token might be expired, try to refresh
        const newTokens = await refreshToken(req.session.refreshToken);
        req.session.accessToken = newTokens.access_token;
        req.session.refreshToken = newTokens.refresh_token;
        // Retry the request with the new token
        return res.status(307).send("Retrying with refreshed token");
      }
      throw new Error("Failed to fetch HubSpot properties");
    }

    const propertiesData = await propertiesResponse.json();
    const hubspotProperties = propertiesData.map((prop) => prop.name);

    // Step 2: Check and create missing properties
    const formProperties = Object.keys(req.body);
    const missingProperties = formProperties.filter(
      (field) => !hubspotProperties.includes(field)
    );

    // Step 3: Create missing properties
    for (const missingProperty of missingProperties) {
      await createProperty(missingProperty, req.session.accessToken);
    }

    // Step 4: Submit form data to HubSpot
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

    // Step 5: Select properties to show in columns
    const selectedProperties = await selectPropertiesToShow(
      req.session.accessToken
    );

    res.json({ success: true, data, selectedProperties });
  } catch (error) {
    console.error("Error submitting to HubSpot:", error);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", await error.response.text());
    }
    res.status(500).json({
      success: false,
      error: error.message || "Failed to submit form",
    });
  }
});

app.post("/create-hubspot-property", async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).send("Not authenticated");
  }

  const { propertyName, label, type = "string", fieldType = "text" } = req.body;

  try {
    const response = await fetch(
      "https://api.hubapi.com/properties/v1/contacts/properties",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: propertyName,
          label: label,
          type: type,
          fieldType: fieldType,
          groupName: "contactinformation",
        }),
      }
    );

    if (!response.ok) {
      throw new Error("Failed to create HubSpot property");
    }

    const data = await response.json();
    res.json({ success: true, data });
  } catch (error) {
    console.error("Error creating HubSpot property:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to create property" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});

console.log(
  "Server code executed. Make sure to set up your environment variables and run the server."
);
