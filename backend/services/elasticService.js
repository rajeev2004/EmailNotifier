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
  ssl: {
    rejectUnauthorized: false, // helps with Render/Elastic Cloud SSL handshake
  },
});

const INDEX = "emails";

client
  .info()
  .then(() => console.log("✅ Connected to Elasticsearch Cloud"))
  .catch((err) =>
    console.error("❌ Elasticsearch connection failed:", err.message)
  );

async function ensureIndex() {
  const exists = await client.indices.exists({ index: INDEX });
  if (!exists) {
    await client.indices.create({
      index: INDEX,
      body: {
        mappings: {
          properties: {
            account: { type: "keyword" },
            folder: { type: "keyword" },
            subject: { type: "text" },
            body: { type: "text" },
            from: { type: "text" },
            to: { type: "text" },
            date: {
              type: "date",
              format: "strict_date_optional_time||epoch_millis",
            },
            category: { type: "keyword" },
          },
        },
      },
    });
    console.log("Created index:", INDEX);
  }
}

export async function indexEmail(doc) {
  await ensureIndex();
  await client.index({ index: INDEX, body: doc });
  await client.indices.refresh({ index: INDEX });
}

export async function searchEmails(query, filters = {}) {
  await ensureIndex();

  const must = query
    ? [{ multi_match: { query, fields: ["subject", "body", "from", "to"] } }]
    : [{ match_all: {} }];

  const boolQuery = { must, filter: [] };
  if (filters.account)
    boolQuery.filter.push({ term: { account: filters.account } });

  const { hits } = await client.search({
    index: INDEX,
    body: {
      query: { bool: boolQuery },
      size: 100,
      sort: [{ date: { order: "desc" } }],
    },
  });

  return hits.hits.map((h) => h._source);
}

export async function searchAll() {
  return searchEmails(null, {});
}
