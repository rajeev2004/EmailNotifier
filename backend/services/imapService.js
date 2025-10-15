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

function normalize(value) {
  return value ? value.trim().toLowerCase() : "";
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

  // Improved duplicate check - check before any processing
  async function checkDuplicate(account, folder, uid) {
    try {
      const docId = `${normalize(account)}-${normalize(folder)}-${uid}`;
      const exists = await client.exists({
        index: INDEX,
        id: docId,
      });
      return exists;
    } catch (err) {
      console.error("Duplicate check error:", err.message);
      return false;
    }
  }

  async function processMessage(msg, sinceDate, folderName = "INBOX") {
    let buffer = "";
    let attributes = null;

    msg.on("body", (stream) =>
      stream.on("data", (chunk) => (buffer += chunk.toString("utf8")))
    );
    msg.once("attributes", (attrs) => (attributes = attrs));

    return new Promise((resolve) => {
      msg.once("end", async () => {
        try {
          if (!buffer || buffer.trim().length === 0) {
            return resolve(null);
          }

          // Check duplicate BEFORE parsing
          if (await checkDuplicate(cfg.name, folderName, attributes?.uid)) {
            console.log(`[${cfg.name}] Skipping duplicate UID: ${attributes.uid}`);
            return resolve(null);
          }

          const parsed = await simpleParser(buffer);

          if (!parsed.from || !parsed.date) {
            return resolve(null);
          }

          // Skip old messages
          if (parsed.date && parsed.date < sinceDate) {
            return resolve(null);
          }

          const doc = {
            account: normalize(cfg.name),
            folder: normalize(folderName),
            uid: attributes?.uid,
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

          const docId = `${doc.account}-${doc.folder}-${doc.uid}`;
          await indexEmail(doc, docId);
          
          console.log(`[${cfg.name}] Indexed: "${doc.subject?.substring(0, 50)}..." [${doc.category}]`);

          // Send notifications for "Interested"
          if (doc.category === "Interested") {
            console.log(`[${cfg.name}] Interested email: ${doc.subject?.substring(0, 50)}...`);
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

  async function fetchEmailsFromFolder(folderName) {
    // Skip non-INBOX folders for real-time processing
    if (folderName !== "INBOX" && !folderName.toLowerCase().includes("inbox")) {
      console.log(`[${cfg.name}] Skipping folder: ${folderName}`);
      return [];
    }

    return new Promise((resolve) => {
      openFolder(folderName, async (err) => {
        if (err) {
          console.log(`[${cfg.name}] Could not open folder ${folderName}:`, err.message);
          return resolve([]);
        }

        const sinceDate = getSinceDate();
        
        console.log(`[${cfg.name}] Checking ${folderName} since ${sinceDate.toISOString().split('T')[0]}`);

        if (imap.state !== "authenticated") {
          return resolve([]);
        }

        function formatImapDate(date) {
          const months = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
          ];
          return `${String(date.getDate()).padStart(2, "0")}-${
            months[date.getMonth()]
          }-${date.getFullYear()}`;
        }

        const sinceStr = formatImapDate(sinceDate);

        imap.search([["SINCE", sinceStr]], async (err, results) => {
          if (err) {
            console.error(`[${cfg.name}] IMAP search error:`, err.message);
            return resolve([]);
          }

          if (!results || results.length === 0) {
            console.log(`[${cfg.name}] No new emails in ${folderName}`);
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
            
            if (docs.length > 0) {
              console.log(`[${cfg.name}] Successfully indexed ${docs.length} email(s) from ${folderName}`);
            } else {
              console.log(`[${cfg.name}] No new emails to index from ${folderName}`);
            }

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

      // Only process INBOX and important folders
      function flattenBoxes(boxes, prefix = "") {
        for (const [name, box] of Object.entries(boxes)) {
          const fullName = prefix
            ? `${prefix}${box.delimiter || "/"}${name}`
            : name;

          // Only add INBOX and select important folders
          const lowerName = fullName.toLowerCase();
          if (lowerName.includes('inbox') || 
              lowerName.includes('primary') ||
              (!box.children || Object.keys(box.children).length === 0)) {
            folderList.push(fullName);
          }
          if (box.children) flattenBoxes(box.children, fullName);
        }
      }

      flattenBoxes(boxes);

      console.log(`[${cfg.name}] Processing ${folderList.length} folder(s)`);

      let totalIndexed = 0;

      for (const folder of folderList) {
        try {
          const docs = await fetchEmailsFromFolder(folder);
          totalIndexed += docs.length;
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (folderErr) {
          console.error(`[${cfg.name}] Error in ${folder}:`, folderErr.message);
          continue;
        }
      }

      console.log(`[${cfg.name}] Initial scan complete: ${totalIndexed} new email(s) indexed`);
      
    } catch (err) {
      console.error(`fetchRecentEmails error for ${cfg.name}:`, err.message);
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
    console.log(`[${cfg.name}] IMAP connected`);

    try {
      await fetchRecentEmails();

      openFolder("INBOX", (err) => {
        if (err) {
          console.error(`[${cfg.name}] INBOX open error:`, err);
          return;
        }

        imap.on("mail", async (numNewMsgs) => {
          console.log(`[${cfg.name}] New mail event: ${numNewMsgs} new message(s)`);
          const newDocs = await fetchNewEmails();
        });
      });

      // Keepalive
      setInterval(() => {
        try {
          if (imap.state === "authenticated" && typeof imap.noop === "function") {
            imap.noop();
          }
        } catch (err) {
          console.error(`[${cfg.name}] Keepalive error:`, err.message);
        }
      }, 15 * 60 * 1000);
    } catch (err) {
      console.error(`[${cfg.name}] IMAP ready handler error:`, err.message);
    }
  });

  imap.on("error", (err) => {
    console.error(`[${cfg.name}] IMAP error:`, err.message);
    setTimeout(() => {
      try {
        imap.connect();
      } catch (reconnectErr) {
        console.error(`[${cfg.name}] Reconnect failed:`, reconnectErr.message);
      }
    }, 30000);
  });

  imap.on("end", () => console.log(`[${cfg.name}] Connection ended`));
  imap.on("close", () => console.log(`[${cfg.name}] Connection closed`));

  try {
    imap.connect();
  } catch (err) {
    console.error(`Initial connection failed for ${cfg.name}:`, err.message);
  }
}