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
    const accountMap = new Map();

    results.forEach((email) => {
      const normalized = email.account.trim();
      const lower = normalized.toLowerCase();

      if (!accountMap.has(lower)) {
        accountMap.set(lower, normalized);
      }
    });

    const accounts = Array.from(accountMap.values()).sort();
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

// Cleanup endpoint to remove duplicates and normalize account names
router.post("/cleanup-duplicates", async (req, res) => {
  try {
    const { Client } = await import("@elastic/elasticsearch");
    const ES_URL = process.env.ES_URL || "http://localhost:9200";
    const client = new Client({
      node: ES_URL,
      auth: {
        username: process.env.ES_USERNAME,
        password: process.env.ES_PASSWORD,
      },
      ssl: { rejectUnauthorized: false },
    });

    const INDEX = "emails";
    const results = await searchAll();

    const seen = new Map();
    const toDelete = [];
    let normalized = 0;

    for (const email of results) {
      const normalizedAccount = email.account.trim();
      const normalizedFolder = (email.folder || "").trim();
      const key = `${normalizedAccount}|${normalizedFolder}|${email.uid}`;

      if (seen.has(key)) {
        toDelete.push({
          account: email.account,
          folder: email.folder,
          uid: email.uid
        });
      } else {
        seen.set(key, email);

        if (email.account !== normalizedAccount || email.folder !== normalizedFolder) {
          await client.updateByQuery({
            index: INDEX,
            body: {
              script: {
                source: "ctx._source.account = params.account; ctx._source.folder = params.folder;",
                params: {
                  account: normalizedAccount,
                  folder: normalizedFolder
                }
              },
              query: {
                bool: {
                  must: [
                    { term: { "account.keyword": email.account } },
                    { term: { "folder.keyword": email.folder || "" } },
                    { term: { uid: email.uid } }
                  ]
                }
              }
            }
          });
          normalized++;
        }
      }
    }

    for (const dup of toDelete) {
      await client.deleteByQuery({
        index: INDEX,
        body: {
          query: {
            bool: {
              must: [
                { term: { "account.keyword": dup.account } },
                { term: { "folder.keyword": dup.folder || "" } },
                { term: { uid: dup.uid } }
              ]
            }
          }
        }
      });
    }

    await client.indices.refresh({ index: INDEX });
    res.json({
      success: true,
      message: `Removed ${toDelete.length} duplicates and normalized ${normalized} records`,
      deleted: toDelete.length,
      normalized
    });
  } catch (err) {
    console.error("Cleanup error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;