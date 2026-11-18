import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope {
  requestId: string;
  /** The JSON-RPC methods in the request's body, when it has one. */
  methods?: string[];
}

export const requestScope = new AsyncLocalStorage<RequestScope>();
