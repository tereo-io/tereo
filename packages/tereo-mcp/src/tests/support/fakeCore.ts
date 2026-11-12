import { parseTestToken } from "@tereo-io/sdk";
import type {
  ActiveIntrospectionResponse,
  CoreClient,
  IntrospectionResponse,
} from "@tereo-io/sdk";

// `overrides` merge into the answer for a test token; pass `introspectToken`
// in `replace` to answer tokens some other way (e.g. reject, or count calls).
export const fakeCore = (
  overrides: Partial<ActiveIntrospectionResponse> = {},
  replace: {
    introspectToken?: (token: string) => Promise<IntrospectionResponse>;
  } = {}
): CoreClient =>
  ({
    auth: {
      introspectToken:
        replace.introspectToken ??
        (async (token: string): Promise<IntrospectionResponse> => {
          const parsed = parseTestToken(token, []);
          return parsed ? { ...parsed, ...overrides } : { active: false };
        }),
    },
  }) as unknown as CoreClient;
