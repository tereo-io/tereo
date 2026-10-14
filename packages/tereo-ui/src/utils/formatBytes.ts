const formatBytes = (bytes: string): string => {
  const value = BigInt(bytes);
  if (value === 0n) return "0 B";

  const k = 1024n;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let current = value;

  while (current >= k && i < sizes.length - 1) {
    current = current / k;
    i++;
  }

  const result =
    i === 0 ? `${current}` : (Number(value) / Math.pow(1024, i)).toFixed(2);

  return `${result} ${sizes[i]}`;
};

export default formatBytes;
