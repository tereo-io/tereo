import useInitiateTotpSetup from "../../api/totp/useInitiateTotpSetup";
import type { StepperStep, StepperStatus } from "@kosmeo-ui/react";
import useVerifyTotpSetup from "../../api/totp/useVerifyTotpSetup";
import { pickOAuthParams } from "../../api/oauthParams";
import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { SessionExpired } from "../SessionExpired";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "react-toastify";
import env from "@/lib/env";
import "./styles.css";
import {
  isExpiredFlowError,
  oauthErrorMessage,
} from "../../api/oauthErrorMessage";
import {
  AuthPage,
  Button,
  Alert,
  Checkbox,
  Input,
  Spinner,
  Col,
  Stepper,
  FormActions,
  FormError,
  RecoveryCodeGrid,
  SecretDisplay,
} from "@kosmeo-ui/react";

interface SetupData {
  secret: string;
  qrCodeUri: string;
  setupToken: string;
  expiresAt: string;
}

type SetupStep = "loading" | "scan" | "verify" | "codes";

const stepStatus = (
  step: SetupStep,
  target: "scan" | "verify" | "codes"
): StepperStatus => {
  const order: SetupStep[] = ["scan", "verify", "codes"];
  if (step === "loading") return target === "scan" ? "active" : "pending";
  const stepIdx = order.indexOf(step);
  const targetIdx = order.indexOf(target);
  if (targetIdx < stepIdx) return "complete";
  if (targetIdx === stepIdx) return "active";
  return "pending";
};

export const TotpSetupPage = () => {
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<SetupStep>("loading");
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [expired, setExpired] = useState<string | null>(null);

  const clientId = searchParams.get("client_id") || "";
  const setupGrant = searchParams.get("setup_grant") || "";
  const setupStarted = useRef(false);

  const { mutate: initiateSetup } = useInitiateTotpSetup();
  const { mutate: verifySetup, isPending: isVerifying } = useVerifyTotpSetup();

  useEffect(() => {
    if (!setupGrant || !clientId) return;
    // The grant is single-use: a second call (StrictMode re-running the
    // effect) would be refused and replace the setup data with an error.
    if (setupStarted.current) return;
    setupStarted.current = true;

    initiateSetup(
      { setupGrant },
      {
        onSuccess: (data) => {
          setSetupData(data);
          setStep("scan");
        },
        onError: (err) => {
          // Without setup data the page has nothing to retry.
          setExpired(
            oauthErrorMessage(
              err,
              "Failed to start 2FA setup. Please sign in again."
            )
          );
        },
      }
    );
  }, [setupGrant, clientId, initiateSetup]);

  useEffect(() => {
    if (step === "verify") {
      inputRef.current?.focus();
    }
  }, [step]);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
    setCode(value);
    setError(null);
  };

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || !setupData) {
      setError("Please enter a 6-digit code");
      return;
    }

    verifySetup(
      { setupToken: setupData.setupToken, totpCode: code },
      {
        onSuccess: (data) => {
          setRecoveryCodes(data.recoveryCodes);
          setStep("codes");
        },
        onError: (err) => {
          const message = oauthErrorMessage(err, "Verification failed");
          if (isExpiredFlowError(err)) setExpired(message);
          else setError(message);
        },
      }
    );
  };

  // Restarts the original authorize request, whose PKCE challenge and state
  // the client still holds.
  const handleContinueToLogin = () => {
    const params = new URLSearchParams({
      ...pickOAuthParams(searchParams),
      response_type: "code",
    });
    window.location.href = `${env.CORE_URL}/oauth/authorize?${params.toString()}`;
  };

  const handleCopyAllCodes = () => {
    navigator.clipboard.writeText(recoveryCodes.join("\n"));
    toast.success("Recovery codes copied to clipboard");
  };

  if (!setupGrant || !clientId) return <SessionExpired width="wide" />;
  if (expired) return <SessionExpired message={expired} width="wide" />;

  if (step === "loading") {
    return (
      <AuthPage
        title="Setting up Two-Factor Authentication"
        subtitle="Please wait..."
        width="wide"
      >
        <div className="t-setup-loading">
          <Spinner size="lg" />
        </div>
      </AuthPage>
    );
  }

  const steps: StepperStep[] = [
    { key: "scan", label: "Scan QR", status: stepStatus(step, "scan") },
    { key: "verify", label: "Verify", status: stepStatus(step, "verify") },
    { key: "codes", label: "Save Codes", status: stepStatus(step, "codes") },
  ];

  const title =
    step === "scan"
      ? "Set Up Two-Factor Authentication"
      : step === "verify"
        ? "Verify Setup"
        : "Save Your Recovery Codes";
  const subtitle =
    step === "scan"
      ? "Two-factor authentication is required for your account"
      : step === "verify"
        ? "Enter the 6-digit code from your authenticator app"
        : "Store these codes securely - you'll need them if you lose your device";

  return (
    <AuthPage title={title} subtitle={subtitle} width="wide">
      <Col>
        <Stepper steps={steps} />

        {step === "scan" && (
          <>
            {error && <FormError>{error}</FormError>}
            {setupData && (
              <>
                <div className="t-setup-step">
                  <h2>Step 1: Scan QR Code</h2>
                  <p>
                    Use an authenticator app like Google Authenticator, Authy,
                    or 1Password to scan this QR code:
                  </p>

                  <div className="t-qr-code-wrapper">
                    <QRCodeSVG value={setupData.qrCodeUri} size={200} />
                  </div>

                  <div className="t-manual-entry">
                    <p>Can't scan the code? Enter this key manually:</p>
                    <SecretDisplay value={setupData.secret} />
                  </div>
                </div>

                <FormActions align="right">
                  <Button onClick={() => setStep("verify")} fullWidth>
                    I've scanned the code - Continue
                  </Button>
                </FormActions>
              </>
            )}
          </>
        )}

        {step === "verify" && (
          <>
            {error && <FormError>{error}</FormError>}
            <form onSubmit={handleVerify}>
              <Col>
                <Input
                  ref={inputRef}
                  label="Verification Code"
                  type="text"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={handleCodeChange}
                  placeholder="000000"
                />

                <FormActions align="between">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setStep("scan");
                      setCode("");
                      setError(null);
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={code.length !== 6 || isVerifying}
                    isLoading={isVerifying}
                  >
                    Verify
                  </Button>
                </FormActions>
              </Col>
            </form>
          </>
        )}

        {step === "codes" && (
          <>
            <Alert variant="warning">
              Each code can only be used once. Save them in a secure location
              like a password manager.
            </Alert>

            <RecoveryCodeGrid codes={recoveryCodes} />
            <FormActions align="right">
              <Button variant="secondary" onClick={handleCopyAllCodes}>
                Copy All
              </Button>
            </FormActions>

            <Alert variant="warning">
              <Checkbox
                id="acknowledge"
                checked={codesAcknowledged}
                onChange={(e) => setCodesAcknowledged(e.target.checked)}
                label="I have saved my recovery codes in a secure location"
                labelLocation="right"
              />
            </Alert>

            <FormActions align="right">
              <Button
                onClick={handleContinueToLogin}
                disabled={!codesAcknowledged}
                fullWidth
              >
                Continue to Login
              </Button>
            </FormActions>
          </>
        )}
      </Col>
    </AuthPage>
  );
};
