import { useEffect, useState } from "react";
import axios from "axios";
import "./App.css";
import SearchBar from "./components/SearchBar";
import Filters from "./components/Filters";
import EmailList from "./components/EmailList";

const API_BASE = "https://emailnotifier-backend.onrender.com/api/emails";

function App() {
  const [emails, setEmails] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    fetchEmails();
    const interval = setInterval(fetchEmails, 30000); // every 30 sec
    return () => clearInterval(interval);
  }, [selectedAccount, query]);

  const fetchEmails = async () => {
    try {
      const filters = {};
      if (query) filters.q = query;
      if (selectedAccount) filters.account = selectedAccount;

      const params = new URLSearchParams(filters);
      const res = await axios.get(`${API_BASE}/search?${params}`);
      setEmails(res.data.data || []);
    } catch (err) {
      console.error("Error fetching emails:", err);
    }
  };

  const fetchAccounts = async () => {
    try {
      const res = await axios.get(`${API_BASE}/accounts`);
      setAccounts(res.data.accounts || []);
    } catch (err) {
      console.error("Error fetching accounts:", err);
    }
  };

  const handleAccountChange = (account) => {
    setSelectedAccount(account);
  };

  const handleSearch = (q) => {
    setQuery(q);
  };

  return (
    <div className="app-container">
      <h1 className="header">📧 Email Dashboard</h1>

      <SearchBar onSearch={handleSearch} />
      <Filters
        accounts={accounts}
        selectedAccount={selectedAccount}
        onAccountChange={handleAccountChange}
      />
      <EmailList emails={emails} />
    </div>
  );
}

export default App;
