import axios from "axios";

// Send Webhook notification
export async function sendWebhook(emailDoc) {
  const WEBHOOK = process.env.WEBHOOK_URL || null;
  if (!WEBHOOK) return;

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
    console.log("Webhook sent:", emailDoc.subject);
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
}

// Send Slack notification
export async function sendSlackNotification(emailDoc) {
  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || null;
  if (!SLACK_WEBHOOK) return;

  try {
    const message = {
      text: `*New Interested Email!*\n\n*Account:* ${emailDoc.account}\n*From:* ${emailDoc.from}\n*Subject:* ${emailDoc.subject}\n*Date:* ${emailDoc.date}`,
    };

    await axios.post(SLACK_WEBHOOK, message);
    console.log("Slack notification sent:", emailDoc.subject);
  } catch (err) {
    console.error("Slack notification error:", err.message);
  }
}
