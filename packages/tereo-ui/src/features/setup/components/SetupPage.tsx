import useSetupStatus, { SETUP_STATUS_KEY } from "../api/useSetupStatus";
import type { CompleteSetupResult, SetupStatus } from "../api/types";
import { useQueryClient } from "@tanstack/react-query";
import useCompleteSetup from "../api/useCompleteSetup";
import { LoginButton } from "@/features/auth";
import { Navigate } from "react-router-dom";
import type { AxiosError } from "axios";
import { useState } from "react";
import {
  Alert,
  AuthPage,
  BorderedSection,
  Button,
  Col,
  DetailField,
  Form,
  Input,
  LoadingOverlay,
} from "@kosmeo-ui/react";

// Core's password rules (passwordSchema in core), checked here so the form
// can say what is wrong before a round trip.
const PASSWORD_RULES: [RegExp, string][] = [
  [/^.{12,}$/, "at least 12 characters"],
  [/[A-Z]/, "an uppercase letter"],
  [/[a-z]/, "a lowercase letter"],
  [/[0-9]/, "a number"],
  [/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, "a special character"],
];

const passwordProblem = (password: string) => {
  const missing = PASSWORD_RULES.filter(([re]) => !re.test(password)).map(
    ([, rule]) => rule
  );
  return missing.length ? `Needs ${missing.join(", ")}` : null;
};

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const toCode = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

interface ApiErrorBody {
  error?: string;
  error_description?: string;
}

const errorMessage = (err: AxiosError<ApiErrorBody>) => {
  const status = err.response?.status;
  if (status === 401) {
    return "That setup token is invalid or has expired. Core prints a new one to its log every time it starts.";
  }
  if (status === 429) {
    return "Too many failed attempts. Wait a few minutes and try again.";
  }
  return (
    err.response?.data?.error_description ||
    err.message ||
    "Setup failed. Check that core is running."
  );
};

export const SetupPage = () => {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useSetupStatus();
  const { mutate, isPending } = useCompleteSetup();

  const [token, setToken] = useState("");
  const [adminName, setAdminName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [code, setCode] = useState("");
  const [codeEdited, setCodeEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteSetupResult | null>(null);

  if (isLoading) return <LoadingOverlay show message="Loading..." />;
  if (status?.setupComplete && !result) return <Navigate to="/" replace />;

  if (result) {
    return (
      <AuthPage title="Setup complete" width="wide">
        <Col>
          <Alert variant="success">
            Tereo is ready. Sign in as the admin you just created.
          </Alert>
          <DetailField label="Admin" value={result.user.email} />
          <DetailField
            label="Organization"
            value={`${result.organization.name} (${result.organization.code})`}
          />
          <LoginButton />
        </Col>
      </AuthPage>
    );
  }

  const handleOrgNameChange = (value: string) => {
    setOrgName(value);
    if (!slugEdited) setSlug(toSlug(value));
    if (!codeEdited) setCode(toCode(value));
  };

  const passwordError = submitted ? passwordProblem(password) : null;
  const confirmError =
    submitted && confirmPassword !== password ? "Passwords do not match" : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setError(null);
    if (passwordProblem(password) || confirmPassword !== password) return;

    mutate(
      {
        token: token.trim(),
        admin: { email: email.trim(), name: adminName.trim(), password },
        organization: { name: orgName.trim(), slug, code },
      },
      {
        onSuccess: (data) => {
          queryClient.setQueryData<SetupStatus>(SETUP_STATUS_KEY, {
            setupComplete: true,
          });
          setResult(data);
        },
        onError: (err) => {
          const axiosError = err as AxiosError<ApiErrorBody>;
          // Someone else finished setup meanwhile: go sign in.
          if (axiosError.response?.status === 404) {
            void queryClient.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
          }
          setError(errorMessage(axiosError));
        },
      }
    );
  };

  return (
    <AuthPage
      title="Set up Tereo"
      subtitle="Create the first admin and name your organization"
      width="wide"
    >
      <Form onSubmit={handleSubmit}>
        <Col>
          {error && <Alert variant="danger">{error}</Alert>}

          <BorderedSection title="Setup token" gap="sm">
            <Input
              label="Token"
              value={token}
              onChange={(e) => setToken(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              autoFocus
              required
              helperText={
                <>
                  Core prints it to its log on start while no admin exists:{" "}
                  <code>
                    docker compose logs core | grep &quot;not set up&quot;
                  </code>
                  . It is valid for 24 hours; a restart prints a new one.
                </>
              }
            />
          </BorderedSection>

          <BorderedSection title="First admin" gap="sm">
            <Input
              label="Name"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              autoComplete="name"
              required
            />
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              error={passwordError}
              helperText="At least 12 characters, with upper and lower case letters, a number and a special character."
            />
            <Input
              label="Confirm password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
              error={confirmError}
            />
          </BorderedSection>

          <BorderedSection title="Organization" gap="sm">
            <Input
              label="Name"
              value={orgName}
              onChange={(e) => handleOrgNameChange(e.target.value)}
              autoComplete="organization"
              placeholder="e.g. Acme"
              required
            />
            <Input
              label="Slug"
              value={slug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value.toLowerCase());
              }}
              placeholder="acme"
              helperText="Lowercase letters, numbers and hyphens."
              required
            />
            <Input
              label="Code"
              value={code}
              onChange={(e) => {
                setCodeEdited(true);
                setCode(toCode(e.target.value));
              }}
              placeholder="ACME"
              helperText="Up to 6 uppercase letters and numbers."
              required
            />
          </BorderedSection>

          <Button type="submit" fullWidth isLoading={isPending}>
            Complete Setup
          </Button>
        </Col>
      </Form>
    </AuthPage>
  );
};
