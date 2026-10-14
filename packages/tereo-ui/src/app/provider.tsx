import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { AuthProvider, AxiosProvider } from "@/lib/auth";
import { ToastContainer } from "react-toastify";
import { ThemeProvider } from "@/lib/theme";
import type { ReactNode } from "react";
import env from "@/lib/env";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

interface AppProviderProps {
  children: ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
  return (
    <QueryClientProvider client={queryClient}>
      <AxiosProvider
        services={{
          auth: env.CORE_URL,
          fileService: `${env.CORE_URL}/v1/files`,
          webhooks: `${env.CORE_URL}/v1/webhooks`,
          audit: `${env.CORE_URL}/v1/audit`,
        }}
      >
        <AuthProvider>
          <ThemeProvider>
            {children}
            <ToastContainer
              position="top-right"
              autoClose={5000}
              hideProgressBar={false}
              newestOnTop
              closeOnClick
              pauseOnFocusLoss
              draggable
              pauseOnHover
            />
          </ThemeProvider>
        </AuthProvider>
        <ReactQueryDevtools initialIsOpen={false} />
      </AxiosProvider>
    </QueryClientProvider>
  );
};
