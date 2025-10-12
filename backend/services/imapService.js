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
    debug: (msg) => console.log(`[${cfg.name}] IMAP:`, msg),
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

  //Fetch last UID
  async function getLastIndexedUID(account, folder) {
    try {
      const { hits } = await client.search({
        index: INDEX,
        body: {
          size: 1,
          sort: [{ uid: { order: "desc" } }],
          query: {
            bool: { must: [{ term: { account } }, { term: { folder } }] },
          },
        },
      });
      if (!hits.hits.length) {
        console.log(`[${account}] No UID found — fetching all emails`);
        return 0; // Force full reindex
      }
      return hits?.hits?.[0]?._source?.uid || 0;
    } catch (err) {
      console.error("Elasticsearch UID fetch error:", err.message);
      return 0;
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
            console.warn(`[${cfg.name}] Skipping empty email body.`);
            return resolve(null);
          }
          const parsed = await simpleParser(buffer);

          if (!parsed.from || !parsed.date) {
            console.warn(
              `[${cfg.name}] Skipping malformed email: missing headers.`
            );
            return resolve(null);
          }

          // Skip old messages
          if (parsed.date && parsed.date < sinceDate) return resolve(null);

          const doc = {
            account: cfg.name,
            folder: folderName,
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

          // Skip duplicates
          const exists = await client.search({
            index: INDEX,
            body: { query: { term: { uid: doc.uid } }, size: 1 },
          });
          if (exists.hits.total.value > 0) return resolve(null);

          // Categorize + Index
          doc.category = categorize(doc);

          await indexEmail(doc);

          // Send notifications for “Interested”
          if (doc.category === "Interested") {
            console.log(
              `[${cfg.name}] Sending Slack + Webhook for: ${doc.subject}`
            );
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
    return new Promise((resolve) => {
      openFolder(folderName, async (err) => {
        if (err) {
          console.error(
            `Error opening folder ${folderName} for ${cfg.name}:`,
            err
          );
          return resolve([]);
        }

        const sinceDate = getSinceDate();
        const lastUID = await getLastIndexedUID(cfg.name, folderName);

        if (imap.state !== "authenticated") {
          console.log(
            `IMAP not authenticated for ${cfg.name}, skipping ${folderName}`
          );
          return resolve([]);
        }
        const sinceStr = sinceDate
          .toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
          .replace(/ /g, "-");
        imap.search(["SINCE", sinceStr], async (err, results) => {
          if (err || !results?.length) return resolve([]);

          const newUIDs = results.filter((uid) => uid > lastUID);
          if (!newUIDs.length) return resolve([]);

          const fetch = imap.fetch(newUIDs, { bodies: "" });
          const messages = [];

          fetch.on("message", (msg) =>
            messages.push(processMessage(msg, sinceDate, folderName))
          );

          fetch.once("end", async () => {
            const docs = (await Promise.all(messages)).filter(Boolean);

            if (docs.length > 0) {
              console.log(
                `[${cfg.name}] ${folderName}: ${docs.length} new emails indexed`
              );
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

      // Flatten nested folders (like [Gmail]/Sent Mail)
      function flattenBoxes(boxes, prefix = "") {
        for (const [name, box] of Object.entries(boxes)) {
          const fullName = prefix
            ? `${prefix}${box.delimiter || "/"}${name}`
            : name;
          folderList.push(fullName);
          if (box.children) flattenBoxes(box.children, fullName);
        }
      }

      flattenBoxes(boxes);

      console.log(`[${cfg.name}] Fetching from folders:`, folderList);
      let totalIndexed = 0;

      for (const folder of folderList) {
        try {
          console.log(`[${cfg.name}] Starting fetch for folder: ${folder}`);
          const docs = await fetchEmailsFromFolder(folder);
          totalIndexed += docs.length;
        } catch (folderErr) {
          console.warn(
            `[${cfg.name}] Skipping folder "${folder}" → ${folderErr.message}`
          );
          continue;
        }
      }

      if (totalIndexed > 0) {
        console.log(`[${cfg.name}] ${totalIndexed} new email(s) indexed`);
      } else {
        console.log(`[${cfg.name}] No new emails`);
      }
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
      imap.getBoxes((err, boxes) => {
        if (err) {
          console.error(`[${cfg.name}] Folder fetch error:`, err);
        } else {
          console.log(`[${cfg.name}] Available folders:`, Object.keys(boxes));
        }
      });

      console.log(`[${cfg.name}] Fetching recent emails...`);
      await fetchRecentEmails();
      console.log(`[${cfg.name}] Initial email fetch complete`);

      openFolder("INBOX", (err) => {
        if (err) {
          console.error(`[${cfg.name}] INBOX open error:`, err);
          return;
        }

        imap.on("mail", async (numNewMsgs) => {
          console.log(`[${cfg.name}] ${numNewMsgs} new email(s) detected`);
          const newDocs = await fetchNewEmails();
          if (newDocs.length > 0) {
            console.log(
              `[${cfg.name}] ${newDocs.length} new email(s) indexed (real-time)`
            );
          }
        });
      });

      setInterval(() => {
        try {
          if (
            imap.state === "authenticated" &&
            typeof imap.noop === "function"
          ) {
            imap.noop();
            console.log(`[${cfg.name}] Keepalive ping`);
          }
        } catch (err) {
          console.error(`[${cfg.name}] Keepalive error:`, err.message);
        }
      }, 15 * 60 * 1000); // every 15 minutes
    } catch (err) {
      console.error(`[${cfg.name}] IMAP ready handler error:`, err.message);
    }
  });

  imap.on("error", (err) => {
    console.error(`IMAP error for ${cfg.name}:`, err.message);
    setTimeout(() => {
      console.log(`Reconnecting IMAP for ${cfg.name}...`);
      try {
        imap.connect();
      } catch (reconnectErr) {
        console.error(
          `Reconnect failed for ${cfg.name}:`,
          reconnectErr.message
        );
      }
    }, 30000);
  });

  imap.on("end", () => console.log(`IMAP connection ended for ${cfg.name}`));
  imap.on("close", (hadError) =>
    console.log(
      `🔌 IMAP connection closed for ${cfg.name}, had error: ${hadError}`
    )
  );

  try {
    imap.connect();
  } catch (err) {
    console.error(`Initial connection failed for ${cfg.name}:`, err.message);
  }
}
