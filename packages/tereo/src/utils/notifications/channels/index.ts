import type { ChannelAdapter, NotificationChannel } from "./types.js";
import { emailAdapter } from "./email.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Adapters differ in their type parameters, so the registry erases them.
type AnyAdapter = ChannelAdapter<any, any, any, any>;

const ADAPTERS: Record<NotificationChannel, AnyAdapter> = {
  email: emailAdapter,
};

export const CHANNELS = Object.keys(ADAPTERS) as NotificationChannel[];

export const getAdapter = (channel: NotificationChannel): AnyAdapter =>
  ADAPTERS[channel];
