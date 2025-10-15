import express from "express";
import { searchAll, searchEmails } from "../services/elasticService.js";

const router = express.Router();

// Fetch all emails
router.get("/", async (req, res) => {
  try {
    const q = req.query.q || null;
    const account = req.query.account || null;

    const results = await searchEmails(q, { account });
    const accounts = [...new Set(results.map((email) => email.account))];

    res.json({
      success: true,
      data: results,
      filters: { account, query: q },
      metadata: {
        total: results.length,
        accounts,
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("Main API error:", err);
    res
      .status(500)
      .json({ success: false, error: "server error", details: err.message });
  }
});

// Search endpoint
router.get("/search", async (req, res) => {
  try {
    const q = req.query.q || null;
    const account = req.query.account || null;
    const results = await searchEmails(q, { account });

    res.json({
      success: true,
      data: results,
      filters: { account, query: q },
      count: results.length,
    });
  } catch (err) {
    console.error("Search API error:", err);
    res
      .status(500)
      .json({ success: false, error: "server error", details: err.message });
  }
});

// Fetch all accounts
router.get("/accounts", async (req, res) => {
  try {
    const results = await searchAll();
    const accounts = [...new Set(results.map((email) => email.account))];
    res.json({ success: true, accounts });
  } catch (err) {
    console.error("Accounts API error:", err);
    res.status(500).json({ success: false, error: "server error" });
  }
});

// AI reply generation
router.post("/suggest-reply", async (req, res) => {
  try {
    const { generateSuggestedReply } = await import(
      "../services/vectorService.js"
    );
    const { emailBody } = req.body;

    if (!emailBody) {
      return res
        .status(400)
        .json({ success: false, error: "Missing email body" });
    }

    const reply = await generateSuggestedReply(emailBody);
    res.json({ success: true, suggestion: reply });
  } catch (err) {
    console.error("AI Suggestion Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// training
router.post("/train", async (req, res) => {
  try {
    const { addToVectorDB } = await import("../services/vectorService.js");
    const { text } = req.body;

    await addToVectorDB(text);
    res.json({ success: true, message: "Training data added." });
  } catch (err) {
    console.error("Training Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

//Keeping the Connection
router.get("/health", (req, res) => {
  res.status(200).send("OK");
});

export default router;
