import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope {
  requestId: string;
}

export const requestScope = new AsyncLocalStorage<RequestScope>();
