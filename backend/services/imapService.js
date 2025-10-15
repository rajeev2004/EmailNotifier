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

  //Fetch last UID
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
                { term: { "account.keyword": normalize(account) } },
                { term: { "folder.keyword": normalize(folder) } },
              ],
            },
          },
        },
      });
      if (!hits.hits.length) {
        return 0;
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
          if (parsed.date && parsed.date < sinceDate) {
            console.log(
              `[${cfg.name}] Skipping old email: "${
                parsed.subject
              }" from ${parsed.date.toISOString()}`
            );
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

          // Skip duplicates
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
          if (exists.hits.total.value > 0) {
            console.log(
              `[${cfg.name}] Skipping duplicate: "${doc.subject}" (UID: ${doc.uid})`
            );
            return resolve(null);
          }

          // Categorize + Index
          doc.category = categorize(doc);

          await indexEmail(doc);
          console.log(
            `[${cfg.name}] Indexed: "${doc.subject}" [${doc.category}]`
          );

          // Send notifications for "Interested"
          if (doc.category === "Interested") {
  console.log(`[${cfg.name}] Interested: ${doc.subject}`);

  // 🔹 Prevent duplicate Slack notifications for same email
  const docId = `${doc.account}-${doc.folder}-${doc.uid}`;
  const alreadyExists = await client.exists({ index: INDEX, id: docId });

  if (!alreadyExists) {
    await sendWebhook(doc);
    await sendSlackNotification(doc);
  } else {
    console.log(`[${cfg.name}] Skipping duplicate Slack notification for UID ${doc.uid}`);
  }
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
          console.log(
            `[${cfg.name}] Could not open folder ${folderName}:`,
            err.message
          );
          return resolve([]);
        }

        const sinceDate = getSinceDate();
        const lastUID = await getLastIndexedUID(cfg.name, folderName);
        if (lastUID > 0) {
  console.log(`[${cfg.name}] Folder ${folderName} already initialized. Fetching only new emails...`);
}
        console.log(
          `[${
            cfg.name
          }] Checking ${folderName} - Last UID: ${lastUID}, Since: ${sinceDate.toISOString()}`
        );

        if (imap.state !== "authenticated") {
          console.log(
            `IMAP not authenticated for ${cfg.name}, skipping ${folderName}`
          );
          return resolve([]);
        }

        // Convert JS Date -> IMAP date format (DD-MMM-YYYY)
        function formatImapDate(date) {
          const months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ];
          return `${String(date.getDate()).padStart(2, "0")}-${
            months[date.getMonth()]
          }-${date.getFullYear()}`;
        }

        const sinceStr = formatImapDate(sinceDate);

        imap.search([["SINCE", sinceStr]], async (err, results) => {
          if (err) {
            console.error(
              `[${cfg.name}] IMAP search error in ${folderName}:`,
              err.message
            );
            return resolve([]);
          }

          if (!results || results.length === 0) {
            console.log(
              `[${cfg.name}] No emails found in ${folderName} since ${sinceStr}`
            );
            return resolve([]);
          }

          console.log(
            `[${cfg.name}] Found ${results.length} email(s) in ${folderName} since ${sinceStr}`
          );

          const newUIDs = results.filter((uid) => uid > lastUID);
          if (newUIDs.length === 0) {
            console.log(
              `[${cfg.name}] All emails in ${folderName} already indexed (last UID: ${lastUID})`
            );
            return resolve([]);
          }

          console.log(
            `[${cfg.name}] Processing ${newUIDs.length} new email(s) in ${folderName}`
          );

          const fetch = imap.fetch(newUIDs, { bodies: "" });
          const messages = [];

          fetch.on("message", (msg) =>
            messages.push(processMessage(msg, sinceDate, folderName))
          );

          fetch.once("error", (fetchErr) => {
            console.error(
              `[${cfg.name}] Fetch error in ${folderName}:`,
              fetchErr.message
            );
          });

          fetch.once("end", async () => {
            const docs = (await Promise.all(messages)).filter(Boolean);

            if (docs.length > 0) {
              console.log(`[${cfg.name}] Indexed ${docs.length} new email(s)`);
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

          // Only add folders that can actually be selected
          if (!box.children || Object.keys(box.children).length === 0) {
            folderList.push(fullName);
          }
          if (box.children) flattenBoxes(box.children, fullName);
        }
      }

      flattenBoxes(boxes);

      console.log(
        `[${cfg.name}] Found ${folderList.length} folder(s): ${folderList.join(
          ", "
        )}`
      );

      let totalIndexed = 0;

      for (const folder of folderList) {
        try {
          const docs = await fetchEmailsFromFolder(folder);
          totalIndexed += docs.length;
          // Add delay between folders to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (folderErr) {
          console.error(
            `[${cfg.name}] Error processing folder ${folder}:`,
            folderErr.message
          );
          continue;
        }
      }

      console.log(
        `[${cfg.name}] Initial scan complete: ${totalIndexed} email(s) indexed total`
      );
      if (totalIndexed === 0) {
        console.log(`[${cfg.name}] No new emails found - all caught up!`);
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
    console.log(`[${cfg.name}] IMAP connected successfully`);
    console.log(
      `[${cfg.name}] Fetching emails from last ${
        process.env.FETCH_DAYS || 30
      } days`
    );

    try {
      await fetchRecentEmails();

      openFolder("INBOX", (err) => {
        if (err) {
          console.error(`[${cfg.name}] INBOX open error:`, err);
          return;
        }

        imap.on("mail", async (numNewMsgs) => {
          const newDocs = await fetchNewEmails();
          if (newDocs.length > 0) {
            console.log(`[${cfg.name}] ${newDocs.length} new email(s)`);
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
  imap.on("close", (hadError) => {
    if (hadError) console.log(`[${cfg.name}] Connection closed with error`);
  });

  try {
    imap.connect();
  } catch (err) {
    console.error(`Initial connection failed for ${cfg.name}:`, err.message);
  }
}
