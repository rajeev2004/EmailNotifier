import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ensureIndex } from "./services/elasticService.js";
import emailRoutes from "./routes/emailRoutes.js";
import { startForAccount } from "./services/imapService.js";
import { indexEmail } from "./services/elasticService.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: "https://rajeev2004.github.io",
    methods: ["GET", "POST"],
  })
);
app.use(express.json());
app.use("/api/emails", emailRoutes);

app.get("/test-index", async (req, res) => {
  const testDoc = {
    account: "Rajeev Mail",
    folder: "INBOX",
    subject: "Render Test Email",
    body: "This is a test email inserted manually into Elasticsearch.",
    from: "test@example.com",
    to: "me@example.com",
    date: new Date().toISOString(),
    category: "Interested",
  };
  await indexEmail(testDoc);
  res.send("✅ Test email indexed!");
});

app.listen(PORT, async () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  try {
    console.log("🔍 Creating or verifying Elasticsearch index...");
    await ensureIndex();
    console.log("Elasticsearch index ready.");
  } catch (err) {
    console.error("Failed to ensure index:", err.message);
  }
  const accounts = [];
  for (let i = 1; i <= 5; i++) {
    const name = process.env[`ACCOUNT_${i}_NAME`];
    if (!name) continue;

    accounts.push({
      name,
      host: process.env[`ACCOUNT_${i}_HOST`],
      port: Number(process.env[`ACCOUNT_${i}_PORT`] || 993),
      user: process.env[`ACCOUNT_${i}_USER`],
      pass: process.env[`ACCOUNT_${i}_PASS`],
    });
  }
  console.log("🔍 Environment check:");
  console.log("ES_URL:", process.env.ES_URL);
  console.log("ES_USERNAME:", process.env.ES_USERNAME);
  console.log("ES_PASSWORD:", process.env.ES_PASSWORD ? "Exists" : "Missing");
  if (!accounts.length) {
    console.warn("No IMAP accounts configured in .env");
  } else {
    accounts.forEach((cfg) => startForAccount(cfg));
  }
});
