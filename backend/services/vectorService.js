import Groq from "groq-sdk";
import { Client } from "@elastic/elasticsearch";

const ES_URL = process.env.ES_URL || "http://localhost:9200";
const client = new Client({ node: ES_URL });
const INDEX = "email_vectors";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function ensureIndex() {
  const exists = await client.indices.exists({ index: INDEX });
  if (!exists) {
    await client.indices.create({
      index: INDEX,
      body: {
        mappings: {
          properties: {
            text: { type: "text" },
            embedding: { type: "dense_vector", dims: 1536 },
          },
        },
      },
    });
  }
}

export async function generateSuggestedReply(emailBody) {
  if (!process.env.GROQ_API_KEY)
    return "Thank you for your email. I'll review this and get back to you soon.";

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You are an email assistant that writes short, polite, context-aware replies.",
        },
        { role: "user", content: emailBody },
      ],
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("Groq reply generation error:", err.message);
    return "Sorry, I could not generate a reply right now.";
  }
}
