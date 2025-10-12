import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import emailRoutes from "./routes/emailRoutes.js";
import { startForAccount } from "./services/imapService.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use("/api/emails", emailRoutes);

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);

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

  if (!accounts.length) {
    console.warn("No IMAP accounts configured in .env");
  } else {
    accounts.forEach((cfg) => startForAccount(cfg));
  }
});
