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
  requestTimeout: 60000,
  maxRetries: 5,
});

const INDEX = "emails";

client
  .info()
  .then(() => {})
  .catch((err) =>
    console.error("Elasticsearch connection failed:", err.message)
  );

export async function ensureIndex() {
  const exists = await client.indices.exists({ index: INDEX });
  if (!exists) {
    await client.indices.create({
      index: INDEX,
      body: {
        mappings: {
          properties: {
            uid: { type: "long" },
            account: {
              type: "text",
              fields: {
                keyword: { type: "keyword" },
              },
            },
            folder: {
              type: "text",
              fields: {
                keyword: { type: "keyword" },
              },
            },
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
  }
}

export async function indexEmail(doc, id = null) {
  await ensureIndex();
  
  const uniqueId = id || `${doc.account}-${doc.folder}-${doc.uid}`;

  await client.index({
    index: INDEX,
    id: uniqueId, // Use consistent ID
    body: doc,
    op_type: "create" // This will fail if document already exists
  });

  await client.indices.refresh({ index: INDEX });
}

export async function searchEmails(query, filters = {}) {
  await ensureIndex();

  const must = query
    ? [{ multi_match: { query, fields: ["subject", "body", "from", "to"] } }]
    : [{ match_all: {} }];

  const boolQuery = { must, filter: [] };
  if (filters.account)
    boolQuery.filter.push({ term: { "account.keyword": filters.account } });

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
