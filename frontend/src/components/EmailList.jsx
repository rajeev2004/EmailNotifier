import "./EmailList.css";
import { useState } from "react";
import axios from "axios";
export default function EmailList({ emails }) {
  const [suggestions, setSuggestions] = useState({});
  const handleSuggest = async (email) => {
    try {
      const res = await axios.post(
        "https://emailnotifier-backend.onrender.com/api/emails/suggest-reply",
        {
          emailBody: email.body,
        }
      );
      setSuggestions((prev) => ({
        ...prev,
        [email.uid]: res.data.suggestion,
      }));
    } catch (err) {
      console.error("AI reply error:", err);
    }
  };
  if (!emails.length) {
    return <p className="empty-msg">No emails found.</p>;
  }

  return (
    <div className="email-list">
      {emails.map((mail, index) => (
        <div key={index} className="email-card">
          <div className="email-header">
            <h3>{mail.subject || "(No Subject)"}</h3>
            <span className="email-date">
              {new Date(mail.date).toLocaleString()}
            </span>
          </div>
          <p className="email-meta">
            <strong>From:</strong> {mail.from} <br />
            <strong>To:</strong> {mail.to}
          </p>
          <p className="email-body">
            {mail.body ? mail.body.slice(0, 150) + "..." : "(No content)"}
          </p>
          <button onClick={() => handleSuggest(mail)}>💬 Suggest Reply</button>

          {suggestions[mail.uid] && (
            <div className="suggested-reply">
              <h4>🤖 Suggested Reply:</h4>
              <p>{suggestions[mail.uid]}</p>
            </div>
          )}
          <div
            className={`category ${
              (mail.category || "uncategorized")
                .toLowerCase()
                .replace(/\s+/g, "-") // replaces spaces with hyphens
            }`}
          >
            {mail.category || "Uncategorized"}
          </div>
        </div>
      ))}
    </div>
  );
}
