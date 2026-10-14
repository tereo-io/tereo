import { useQuery } from "@tanstack/react-query";

// A missing spec is not a 404: both core and the dev server answer unknown
// paths under the UI with index.html, so an HTML response means "absent".
const fetchSpecAvailable = async (url: string): Promise<boolean> => {
  const res = await fetch(url, { method: "HEAD" });
  const contentType = res.headers.get("content-type") ?? "";
  return res.ok && !contentType.includes("text/html");
};

export const useSpecAvailable = (url: string) =>
  useQuery({
    queryKey: ["api-docs", "spec-available", url],
    queryFn: () => fetchSpecAvailable(url),
    staleTime: Infinity,
    retry: false,
  });
