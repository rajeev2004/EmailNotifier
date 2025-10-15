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

// ✅ Ensure index exists with correct mappings
export async function ensureIndex() {
  const exists = await client.indices.exists({ index: INDEX });
  if (!exists) {
    await client.indices.create({
      index: INDEX,
      body: {
        settings: {
          analysis: {
            normalizer: {
              lowercase: {
                type: "custom",
                char_filter: [],
                filter: ["lowercase"],
              },
            },
          },
        },
        mappings: {
          properties: {
            uid: { type: "long" },
            account: { type: "keyword", normalizer: "lowercase" },
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
  }
}

// ✅ Index with unique ID to prevent duplicates
export async function indexEmail(doc) {
  await ensureIndex();

  // Unique per-account/folder/UID combination
  const docId = `${doc.account}-${doc.folder}-${doc.uid}`;

  try {
    await client.index({
      index: INDEX,
      id: docId,
      body: doc,
      op_type: "create", // prevents duplicates
    });
    await client.indices.refresh({ index: INDEX });
  } catch (err) {
    if (err.meta?.body?.error?.type === "version_conflict_engine_exception") {
      console.log(`[${doc.account}] Duplicate detected: ${doc.subject}`);
    } else {
      console.error("Index error:", err.message);
    }
  }
}

// ✅ Enhanced search with proper filters and relevance
export async function searchEmails(query, filters = {}) {
  await ensureIndex();

  const must = query
    ? [
        {
          simple_query_string: {
            query,
            fields: ["subject^3", "body", "from", "to"],
            default_operator: "and",
          },
        },
      ]
    : [{ match_all: {} }];

  const boolQuery = { must, filter: [] };

  if (filters.account) {
    boolQuery.must.push({
      match_phrase: { account: filters.account },
    });
  }

  if (filters.category) {
    boolQuery.filter.push({
      term: { "category.keyword": filters.category },
    });
  }

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
