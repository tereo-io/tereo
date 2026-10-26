import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { AuthProvider, AxiosProvider } from "@/lib/auth";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { ToastContainer } from "react-toastify";
import type { ReactNode } from "react";
import env from "@/lib/env";
import "./toasts.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Its own component so it can read the theme from ThemeProvider.
const ThemedToastContainer = () => {
  const { resolvedTheme } = useTheme();
  return (
    <ToastContainer
      position="top-right"
      autoClose={5000}
      hideProgressBar={false}
      newestOnTop
      closeOnClick
      pauseOnFocusLoss
      draggable
      pauseOnHover
      theme={resolvedTheme}
    />
  );
};

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
            <ThemedToastContainer />
          </ThemeProvider>
        </AuthProvider>
        <ReactQueryDevtools initialIsOpen={false} />
      </AxiosProvider>
    </QueryClientProvider>
  );
};
