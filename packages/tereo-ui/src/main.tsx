import { ErrorBoundary } from "@/components/ErrorBoundary";
import "react-toastify/dist/ReactToastify.css";
import { createRoot } from "react-dom/client";
import "@kosmeo-ui/react/styles.css";
import { StrictMode } from "react";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("No root element found");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
