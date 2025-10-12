import axios from "axios";

let lastWebhookTime = 0;
let lastSlackTime = 0;
const MIN_DELAY = 2000; // 2 seconds between notifications

// Send Webhook notification
export async function sendWebhook(emailDoc) {
  const WEBHOOK = process.env.WEBHOOK_URL || null;
  if (!WEBHOOK) return;

  // Rate limiting
  const now = Date.now();
  const timeSinceLastWebhook = now - lastWebhookTime;
  if (timeSinceLastWebhook < MIN_DELAY) {
    await new Promise(resolve => setTimeout(resolve, MIN_DELAY - timeSinceLastWebhook));
  }

  try {
    await axios.post(WEBHOOK, {
      type: "new_interested_email",
      email: {
        account: emailDoc.account,
        subject: emailDoc.subject,
        from: emailDoc.from,
        date: emailDoc.date,
        category: emailDoc.category,
      },
    });
    lastWebhookTime = Date.now();
  } catch (err) {
    if (err.response?.status === 429) {
      console.error("⚠️ Webhook rate limited");
    } else {
      console.error("Webhook error:", err.message);
    }
  }
}

// Send Slack notification
export async function sendSlackNotification(emailDoc) {
  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || null;
  if (!SLACK_WEBHOOK) return;

  // Rate limiting
  const now = Date.now();
  const timeSinceLastSlack = now - lastSlackTime;
  if (timeSinceLastSlack < MIN_DELAY) {
    await new Promise(resolve => setTimeout(resolve, MIN_DELAY - timeSinceLastSlack));
  }

  try {
    const message = {
      text: `*New Interested Email!*\n\n*Account:* ${emailDoc.account}\n*From:* ${emailDoc.from}\n*Subject:* ${emailDoc.subject}\n*Date:* ${emailDoc.date}`,
    };

    await axios.post(SLACK_WEBHOOK, message);
    lastSlackTime = Date.now();
  } catch (err) {
    if (err.response?.status === 429) {
      console.error("⚠️ Slack rate limited");
    } else {
      console.error("Slack notification error:", err.message);
    }
  }
}
