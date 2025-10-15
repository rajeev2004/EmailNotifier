import Imap from "node-imap";
import { simpleParser } from "mailparser";
import { indexEmail } from "./elasticService.js";
import { categorize } from "./aiCategorizer.js";
import { sendWebhook, sendSlackNotification } from "./notifier.js";
import { Client } from "@elastic/elasticsearch";

const ES_URL = process.env.ES_URL || "http://localhost:9200";
const ES_USERNAME = process.env.ES_USERNAME;
const ES_PASSWORD = process.env.ES_PASSWORD;

const client = new Client({
  node: ES_URL,
  auth: {
    username: ES_USERNAME,
    password: ES_PASSWORD,
  },
  ssl: { rejectUnauthorized: false },
});

const INDEX = "emails";

function getSinceDate() {
  const fetchDays = parseInt(process.env.FETCH_DAYS || "30", 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - fetchDays);
  return cutoff;
}

export function startForAccount(cfg) {
  const imap = new Imap({
    user: cfg.user,
    password: cfg.pass,
    host: cfg.host,
    port: cfg.port || 993,
    tls: true,
    tlsOptions: { servername: cfg.host, rejectUnauthorized: false },
  });

  const openFolder = (folderName, cb) => imap.openBox(folderName, false, cb);

  const getFolders = () =>
    new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        if (err) {
          console.error(`Error getting folders for ${cfg.name}:`, err);
          return reject(err);
        }
        resolve(boxes);
      });
    });

  async function processMessage(msg, sinceDate, folderName = "INBOX") {
    let buffer = "";
    let attributes = null;

    msg.on("body", (stream) => {
      stream.on("data", (chunk) => (buffer += chunk.toString("utf8")));
    });
    msg.once("attributes", (attrs) => (attributes = attrs));

    return new Promise((resolve) => {
      msg.once("end", async () => {
        try {
          if (!buffer.trim()) {
            console.warn(`[${cfg.name}] Skipping empty email body.`);
            return resolve(null);
          }

          const parsed = await simpleParser(buffer);

          if (!parsed.from || !parsed.date) {
            console.warn(`[${cfg.name}] Skipping malformed email.`);
            return resolve(null);
          }

          // Skip old emails
          if (parsed.date < sinceDate) {
            console.log(
              `[${cfg.name}] Skipping old: "${parsed.subject}" from ${parsed.date.toISOString()}`
            );
            return resolve(null);
          }

          const doc = {
            account: cfg.name.toLowerCase(), // normalized
            folder: folderName,
            uid: Number(attributes?.uid || 0),
            subject: parsed.subject || "",
            from: parsed.from?.text || "",
            to: parsed.to?.text || "",
            date: parsed.date
              ? parsed.date.toISOString()
              : new Date().toISOString(),
            body: parsed.text || "",
            html: parsed.html || "",
          };

          // Categorize + Index
          doc.category = categorize(doc);
          await indexEmail(doc);

          console.log(`[${cfg.name}] Indexed: "${doc.subject}" [${doc.category}]`);

          if (doc.category === "Interested") {
            await sendWebhook(doc);
            await sendSlackNotification(doc);
          }

          resolve(doc);
        } catch (err) {
          console.error("Message parse/index error:", err.message);
          resolve(null);
        }
      });
    });
  }

  function formatImapDate(date) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${String(date.getDate()).padStart(2, "0")}-${months[date.getMonth()]}-${date.getFullYear()}`;
  }

  async function fetchEmailsFromFolder(folderName) {
    return new Promise((resolve) => {
      openFolder(folderName, async (err) => {
        if (err) {
          console.error(`[${cfg.name}] Could not open folder ${folderName}:`, err.message);
          return resolve([]);
        }

        const sinceDate = getSinceDate();
        const sinceStr = formatImapDate(sinceDate);

        imap.search([["SINCE", sinceStr]], async (err, results) => {
          if (err) {
            console.error(`[${cfg.name}] IMAP search error:`, err.message);
            return resolve([]);
          }

          if (!results?.length) {
            console.log(`[${cfg.name}] No new emails in ${folderName} since ${sinceStr}`);
            return resolve([]);
          }

          console.log(`[${cfg.name}] Found ${results.length} email(s) in ${folderName}`);
          const fetch = imap.fetch(results, { bodies: "" });
          const messages = [];

          fetch.on("message", (msg) =>
            messages.push(processMessage(msg, sinceDate, folderName))
          );

          fetch.once("error", (fetchErr) => {
            console.error(`[${cfg.name}] Fetch error:`, fetchErr.message);
          });

          fetch.once("end", async () => {
            const docs = (await Promise.all(messages)).filter(Boolean);
            console.log(`[${cfg.name}] Indexed ${docs.length} new email(s)`);
            resolve(docs);
          });
        });
      });
    });
  }

  async function fetchRecentEmails() {
    try {
      const boxes = await getFolders();
      const folderList = [];

      function flattenBoxes(boxes, prefix = "") {
        for (const [name, box] of Object.entries(boxes)) {
          const fullName = prefix
            ? `${prefix}${box.delimiter || "/"}${name}`
            : name;
          if (!box.children || Object.keys(box.children).length === 0)
            folderList.push(fullName);
          if (box.children) flattenBoxes(box.children, fullName);
        }
      }

      flattenBoxes(boxes);
      console.log(`[${cfg.name}] Folders: ${folderList.join(", ")}`);

      let total = 0;
      for (const folder of folderList) {
        const docs = await fetchEmailsFromFolder(folder);
        total += docs.length;
        await new Promise((r) => setTimeout(r, 1000));
      }

      console.log(`[${cfg.name}] Initial scan complete: ${total} indexed`);
    } catch (err) {
      console.error(`[${cfg.name}] fetchRecentEmails error:`, err.message);
    }
  }

  async function fetchNewEmails() {
    try {
      return await fetchEmailsFromFolder("INBOX");
    } catch (err) {
      console.error(`[${cfg.name}] Real-time fetch error:`, err.message);
      return [];
    }
  }

  imap.once("ready", async () => {
    console.log(`[${cfg.name}] IMAP connected successfully`);
    await fetchRecentEmails();

    openFolder("INBOX", (err) => {
      if (err) {
        console.error(`[${cfg.name}] INBOX open error:`, err);
        return;
      }

      imap.on("mail", async () => {
        const newDocs = await fetchNewEmails();
        if (newDocs.length > 0)
          console.log(`[${cfg.name}] ${newDocs.length} new email(s)`);
      });
    });

    setInterval(() => {
      try {
        if (imap.state === "authenticated") imap.noop();
      } catch (err) {
        console.error(`[${cfg.name}] Keepalive error:`, err.message);
      }
    }, 15 * 60 * 1000);
  });

  imap.on("error", (err) => {
    console.error(`[${cfg.name}] IMAP error:`, err.message);
    setTimeout(() => imap.connect(), 30000);
  });

  imap.on("end", () => console.log(`[${cfg.name}] Connection ended`));
  imap.on("close", (hadError) => {
    if (hadError) console.log(`[${cfg.name}] Connection closed with error`);
  });

  try {
    imap.connect();
  } catch (err) {
    console.error(`Initial connection failed for ${cfg.name}:`, err.message);
  }
}
