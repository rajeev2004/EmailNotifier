# 📧 Email Notifier System

## 🔍 Overview
The **Email Notifier System** is a full-stack web application that automatically connects to multiple Gmail accounts, fetches and categorizes incoming emails using IMAP, and indexes them into **Elasticsearch** for fast retrieval. It also sends **real-time Slack or Webhook notifications** whenever an *Interested* email is received — ideal for automating lead tracking or CRM integration.  

This project includes:  
- 🖥️ **Node.js + Express backend** (deployed on Render)  
- 🔎 **Elasticsearch Cloud** for indexing and searching  
- 🌐 **React + Vite frontend** (hosted on GitHub Pages)  
- 🤖 **Groq AI** for intelligent email replies and categorization  

---

## 🚀 Features
✅ Automatic IMAP email fetching from multiple Gmail accounts  
✅ AI-based email categorization  
✅ Real-time email indexing in Elasticsearch  
✅ Instant Slack + Webhook notifications for *Interested* mails  
✅ Search and filter emails by account or keyword  
✅ AI-generated reply suggestions (Groq API)  
✅ Cloud deployment with backend (Render) and frontend (GitHub Pages)  

---

## 🛠️ Setup Instructions

### 1️⃣ Clone the Repository
```bash
git clone https://github.com/rajeev2004/EmailNotifier.git
cd EmailNotifier
```

---

### 2️⃣ Install Dependencies
```bash
npm install
```

---

### 3️⃣ Create a `.env` File in the backend and Add the Following:
```bash
PORT=3001

# Elasticsearch Cloud
ES_URL=https://<your-elastic-url>
ES_USERNAME=elastic
ES_PASSWORD=<your-elastic-password>

# Groq AI API
GROQ_API_KEY=<your-groq-api-key>

# IMAP Accounts
ACCOUNT_1_NAME=Primary Mail
ACCOUNT_1_USER=your1@gmail.com
ACCOUNT_1_PASS=<app-password>
ACCOUNT_1_HOST=imap.gmail.com
ACCOUNT_1_PORT=993

ACCOUNT_2_NAME=Secondary Mail
ACCOUNT_2_USER=your2@gmail.com
ACCOUNT_2_PASS=<app-password>
ACCOUNT_2_HOST=imap.gmail.com
ACCOUNT_2_PORT=993

# Notifications (optional)
WEBHOOK_URL=<optional-webhook-endpoint>
SLACK_WEBHOOK_URL=<optional-slack-webhook>
```

⚠️ **Note:**  
- Use **Gmail App Passwords**, not your normal password.  
- Make sure IMAP is enabled in your Gmail account settings.  

---

### 4️⃣ Run the Server
```bash
backend: node server.js
frontend: npm run dev
```

When everything runs correctly, you’ll see:
```
Backend running on http://localhost:3001
Connected to Elasticsearch Cloud
[Primary Mail] IMAP connected
[Secondary Mail] IMAP connected
Fetching recent emails...
```

---

## 🧠 Categorization Logic
| Category | Keywords Detected |
|-----------|-------------------|
| Interested | interested, keen, sounds good, count me in |
| Not Interested | not interested, no thanks, unsubscribe |
| Meeting Booked | meeting, schedule, call, booked |
| Spam | click here, buy now, winner, claim prize |
| Out of Office | ooo, out of office, on vacation |

---


## 🧾 Deployment Details
| Component | Platform | URL |
|------------|-----------|-----|
| **Frontend** | GitHub Pages | https://rajeev2004.github.io/EmailNotifier/ |
| **Database** | Elasticsearch Cloud | Hosted on Elastic Cloud |
| **AI API** | Groq (Llama 3.1) | Used for smart replies |

---

## 🎥 Demo
You can check out the live project here:  
🔗 [**Live Website**](https://rajeev2004.github.io/EmailNotifier/)  


## ⭐ Summary
The **Email Notifier System** integrates IMAP, AI, and Elasticsearch to create a **real-time, intelligent email management platform**. It enables automatic detection, classification, and response generation for emails — combining automation, search, and artificial intelligence to simplify communication tracking.
