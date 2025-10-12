export function categorize(email) {
  const text = ((email.subject || "") + " " + (email.body || "")).toLowerCase();

  if (
    /out of office|out-of-office|on vacation|ooo|out for the day/.test(text)
  ) {
    return "Out of Office";
  }
  if (
    /meeting|calendar|booked|scheduled|schedule|call|interview|slot|time available/.test(
      text
    )
  ) {
    return "Meeting Booked";
  }
  if (
    /not interested|no thanks|no thank you|not interested|no longer interested|unsubscribe/.test(
      text
    )
  ) {
    return "Not Interested";
  }
  if (
    /free money|claim prize|click here|buy now|hot deal|lottery|winner|unsubscribe here/.test(
      text
    )
  ) {
    return "Spam";
  }
  if (
    /interested|keen|would love|i am interested|sounds good|count me in|open to/.test(
      text
    )
  ) {
    return "Interested";
  }
  return "Uncategorized";
}
