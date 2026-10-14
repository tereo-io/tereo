import { useEffect, useState } from "react";

/**
 * An object URL for `blob`, revoked when the blob changes or the component
 * unmounts. The Blob is what gets cached (react-query), never the URL: a
 * cached URL outlives every component that could revoke it.
 */
const useObjectUrl = (blob: Blob | null | undefined): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return url;
};

export default useObjectUrl;
