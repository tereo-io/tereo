import { configureAuth } from "@/lib/auth";
import { AppProvider } from "./provider";
import { AppRouter } from "./router";
import env from "@/lib/env";

export const App = () => {
  configureAuth({
    AUTH_SERVER_URL: env.CORE_URL,
    REDIRECT_URI: env.REDIRECT_URI,
    CLIENT_ID: env.CLIENT_ID,
    basePath: env.BASE_PATH,
    logoutRedirectPath: env.HOME_PATH,
    unauthorizedRedirectPath: env.HOME_PATH,
    tokenExpirationBuffer: 60000,
  });

  return (
    <AppProvider>
      <AppRouter />
    </AppProvider>
  );
};
