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
  auth: { username: ES_USERNAME, password: ES_PASSWORD },
  ssl: { rejectUnauthorized: false },
});

const INDEX = "emails";

// In-memory tracking to prevent duplicates during runtime
const processedUIDs = new Map(); // key: account-folder -> Set of UIDs
const lastUIDs = {}; // key: account-folder -> last UID processed

function markUID(account, folder, uid) {
  const key = `${account}-${folder}`;
  if (!processedUIDs.has(key)) processedUIDs.set(key, new Set());
  processedUIDs.get(key).add(uid);
  lastUIDs[key] = uid;
}

function hasProcessed(account, folder, uid) {
  const key = `${account}-${folder}`;
  return processedUIDs.has(key) && processedUIDs.get(key).has(uid);
}

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

  async function getLastIndexedUID(account, folder) {
    try {
      const { hits } = await client.search({
        index: INDEX,
        body: {
          size: 1,
          sort: [{ uid: { order: "desc" } }],
          query: {
            bool: {
              must: [
                { term: { "account.keyword": account } },
                { term: { "folder.keyword": folder } },
              ],
            },
          },
        },
      });
      if (!hits.hits.length) return 0;
      return hits.hits[0]._source?.uid || 0;
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
          if (!buffer.trim()) return resolve(null);

          const parsed = await simpleParser(buffer);
          if (!parsed.from || !parsed.date) return resolve(null);

          if (parsed.date < sinceDate) return resolve(null);

          const doc = {
            account: cfg.name,
            folder: folderName,
            uid: attributes?.uid,
            subject: parsed.subject || "",
            from: parsed.from?.text || "",
            to: parsed.to?.text || "",
            date: parsed.date.toISOString(),
            body: parsed.text || "",
            html: parsed.html || "",
          };

          // Skip duplicates (in-memory first, then ES)
          if (hasProcessed(doc.account, doc.folder, doc.uid)) return resolve(null);

          const exists = await client.search({
            index: INDEX,
            body: {
              query: {
                bool: {
                  must: [
                    { term: { "account.keyword": doc.account } },
                    { term: { "folder.keyword": doc.folder } },
                    { term: { uid: doc.uid } },
                  ],
                },
              },
              size: 1,
            },
          });
          if (exists.hits.total.value > 0) return resolve(null);

          doc.category = categorize(doc);
          await indexEmail(doc, true); // true = refresh immediately
          markUID(doc.account, doc.folder, doc.uid);

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

  async function fetchEmailsFromFolder(folderName) {
    return new Promise((resolve) => {
      openFolder(folderName, async (err) => {
        if (err) return resolve([]);

        const sinceDate = getSinceDate();
        const key = `${cfg.name}-${folderName}`;
        const lastUID = lastUIDs[key] || (await getLastIndexedUID(cfg.name, folderName));

        if (imap.state !== "authenticated") return resolve([]);

        const formatImapDate = (date) => {
          const months = [
            "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec",
          ];
          return `${String(date.getDate()).padStart(2, "0")}-${months[date.getMonth()]}-${date.getFullYear()}`;
        };

        const sinceStr = formatImapDate(sinceDate);

        imap.search([["SINCE", sinceStr]], async (err, results) => {
          if (err || !results?.length) return resolve([]);

          const newUIDs = results.filter((uid) => uid > lastUID);
          if (!newUIDs.length) return resolve([]);

          const fetch = imap.fetch(newUIDs, { bodies: "" });
          const messages = [];

          fetch.on("message", (msg) => messages.push(processMessage(msg, sinceDate, folderName)));

          fetch.once("error", (fetchErr) => console.error(`[${cfg.name}] Fetch error in ${folderName}:`, fetchErr.message));

          fetch.once("end", async () => {
            const docs = (await Promise.all(messages)).filter(Boolean);
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

      const flattenBoxes = (boxes, prefix = "") => {
        for (const [name, box] of Object.entries(boxes)) {
          const fullName = prefix ? `${prefix}${box.delimiter || "/"}${name}` : name;
          if (!box.children || Object.keys(box.children).length === 0) folderList.push(fullName);
          if (box.children) flattenBoxes(box.children, fullName);
        }
      };

      flattenBoxes(boxes);

      for (const folder of folderList) {
        try {
          await fetchEmailsFromFolder(folder);
          await new Promise((r) => setTimeout(r, 1000));
        } catch (folderErr) { console.error(folderErr.message); }
      }
    } catch (err) {
      console.error(err.message);
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
    try {
      await fetchRecentEmails();

      openFolder("INBOX", (err) => {
        if (err) return console.error(err);

        imap.on("mail", async () => {
          await fetchNewEmails();
        });
      });

      setInterval(() => {
        try { if (imap.state === "authenticated") imap.noop(); } catch {}
      }, 15 * 60 * 1000);
    } catch (err) { console.error(err.message); }
  });

  imap.on("error", (err) => {
    console.error(`[${cfg.name}] IMAP error:`, err.message);
    setTimeout(() => { try { imap.connect(); } catch {} }, 30000);
  });

  imap.on("end", () => console.log(`[${cfg.name}] Connection ended`));
  imap.on("close", (hadError) => hadError && console.log(`[${cfg.name}] Connection closed with error`));

  try { imap.connect(); } catch (err) { console.error(err.message); }
}
