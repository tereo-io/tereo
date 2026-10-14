import { Centered, Col } from "@kosmeo-ui/react";
import { LoginButton } from "@/features/auth";
import { Outlet } from "react-router-dom";
import { RouteTitle } from "./RouteTitle";
import { useAuth } from "@/lib/auth";
import { TopBar } from "./TopBar";
import "./RootLayout.css";

export const RootLayout = () => {
  const { user, isLoading } = useAuth();

  // AppRouter's overlay covers the wait; the sign-in prompt would flash.
  if (!user && isLoading) return null;
  if (!user) {
    return (
      <Centered>
        <div className="t-welcome-container">
          <Col size="lg">
            <h1>Tereo</h1>
            <p>Sign in to get started.</p>
            <LoginButton />
          </Col>
        </div>
      </Centered>
    );
  }

  return (
    <div className="t-root">
      <RouteTitle />
      <TopBar />
      <div className="t-body">
        <Outlet />
      </div>
    </div>
  );
};
