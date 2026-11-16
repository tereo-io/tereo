import { useQueryClient } from "@tanstack/react-query";
import { TereoAuthProvider } from "@tereo-io/react";
import { type ReactNode, useState } from "react";
import { createCoreAuthConfig } from "./config";

/** Signs core's UI in through core. Needs a `QueryClientProvider` above it. */
export const CoreAuthProvider = ({ children }: { children: ReactNode }) => {
  const queryClient = useQueryClient();
  const [config] = useState(() => createCoreAuthConfig(queryClient));
  return <TereoAuthProvider config={config}>{children}</TereoAuthProvider>;
};
