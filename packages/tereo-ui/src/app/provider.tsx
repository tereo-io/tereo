import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { ToastContainer } from "react-toastify";
import { CoreAuthProvider } from "@/lib/auth";
import type { ReactNode } from "react";
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
      <CoreAuthProvider>
        <ThemeProvider>
          {children}
          <ThemedToastContainer />
        </ThemeProvider>
      </CoreAuthProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
};
