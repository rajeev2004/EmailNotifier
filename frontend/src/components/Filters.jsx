import "./Filters.css";

export default function Filters({
  accounts,
  selectedAccount,
  onAccountChange,
}) {
  return (
    <div className="filters">
      <select
        value={selectedAccount}
        onChange={(e) => onAccountChange(e.target.value)}
      >
        <option value="">All Accounts</option>
        {accounts.map((acc) => (
          <option key={acc} value={acc}>
            {acc}
          </option>
        ))}
      </select>
    </div>
  );
}
