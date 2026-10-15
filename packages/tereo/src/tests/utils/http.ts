export interface JsonResponse {
  status: number;
  // Whatever the route answered, or null for an empty body: each test asserts
  // the shape it expects, so typing it here would only repeat those checks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export const fetchJson = async (
  method: string,
  url: string,
  token: string | null,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<JsonResponse> => {
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
};
