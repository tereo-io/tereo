import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import env from "@/lib/env";
import "./styles.css";
import {
  Alert,
  Button,
  Card,
  Centered,
  Col,
  Page,
  Row,
} from "@kosmeo-ui/react";

interface ErrorPageProps {
  error?: Error | null;
  /** Stack trace or component stack to show in dev. */
  details?: string | null;
  /** Optional reset handler. If omitted, "Try again" is hidden. */
  onReset?: () => void;
  /** Optional "Go home" path. Defaults to the app's root. */
  homeHref?: string;
}

export const ErrorPage = ({
  error,
  details,
  onReset,
  homeHref = env.HOME_PATH,
}: ErrorPageProps) => {
  const isDev = env.IS_DEV;
  const message = error?.message || "An unexpected error occurred.";
  const stack = error?.stack || details;

  return (
    <Page padded maxWidth="narrow">
      <Centered>
        <Card
          padding="large"
          align="center"
          footer={
            <Row size="sm" justify="center">
              {onReset && (
                <Button variant="primary" onClick={onReset} fullWidth={false}>
                  Try again
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  window.location.href = homeHref;
                }}
                fullWidth={false}
              >
                Go home
              </Button>
            </Row>
          }
        >
          <Col size="md" align="center">
            <div className="t-error-page-icon">
              <FontAwesomeIcon icon={faTriangleExclamation} size="2x" />
            </div>
            <Alert variant="danger" heading="Something went wrong">
              {message}
            </Alert>
            {isDev && stack && (
              <details className="t-error-page-details">
                <summary>Error details</summary>
                <pre>{stack}</pre>
              </details>
            )}
          </Col>
        </Card>
      </Centered>
    </Page>
  );
};
