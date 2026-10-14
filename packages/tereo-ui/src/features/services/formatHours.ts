/** Core's hour settings are plain numbers: "1 hour", "24 hours", "1.5 hours". */
const formatHours = (hours: number) =>
  `${hours} ${hours === 1 ? "hour" : "hours"}`;

export default formatHours;
