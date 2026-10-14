import { AuthPage, Alert, Col } from "@kosmeo-ui/react";
import { BackToSignIn } from "./BackToSignIn";

interface SessionExpiredProps {
  message?: string;
  width?: "wide";
}

export const SessionExpired = ({ message, width }: SessionExpiredProps) => (
  <AuthPage title="Session Expired" width={width}>
    <Col>
      <Alert variant="danger">
        {message ||
          "Your session has expired or is invalid. Please start the login process again."}
      </Alert>
      <BackToSignIn />
    </Col>
  </AuthPage>
);
