import "./SearchBar.css";

export default function SearchBar({ onSearch }) {
  return (
    <div className="search-bar">
      <input
        type="text"
        placeholder="🔍 Search emails..."
        onChange={(e) => onSearch(e.target.value)}
      />
    </div>
  );
}
