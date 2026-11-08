import useInspectEmailVerification from "../../api/email/useInspectEmailVerification";
import { Alert, Button, Col, Spinner } from "@kosmeo-ui/react";
import useConfirmEmail from "../../api/email/useConfirmEmail";
import { BrandedAuthPage } from "@/features/auth/branding";
import { useLocation } from "react-router-dom";
import { isAxiosError } from "axios";
import { useMemo } from "react";

const TITLE = "Confirm your email address";
const EXPIRED = "This link is no longer valid or has expired.";
const TRY_AGAIN =
  "Too many attempts or the service is busy. Try again shortly.";

const isTransient = (err: unknown): boolean =>
  isAxiosError(err) &&
  (err.response?.status === 429 || err.response?.status === 503);

/** The link carries its token in the fragment, which never reaches server logs or Referer headers. */
const tokenFromHash = (hash: string): string =>
  new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";

/** Mail scanners open links, so the address is confirmed only by the click. */
export const VerifyEmailPage = () => {
  const { hash } = useLocation();
  const token = useMemo(() => tokenFromHash(hash), [hash]);
  const {
    data: details,
    isLoading,
    isError,
    error: inspectError,
    refetch,
  } = useInspectEmailVerification(token);
  const confirm = useConfirmEmail();

  if (confirm.isSuccess) {
    return (
      <BrandedAuthPage title={TITLE}>
        <Alert variant="success">Your email address is confirmed.</Alert>
      </BrandedAuthPage>
    );
  }

  if (token && isError && isTransient(inspectError)) {
    return (
      <BrandedAuthPage title={TITLE}>
        <Col>
          <Alert variant="warning">{TRY_AGAIN}</Alert>
          <Button fullWidth onClick={() => void refetch()}>
            Try again
          </Button>
        </Col>
      </BrandedAuthPage>
    );
  }

  if (!token || isError) {
    return (
      <BrandedAuthPage title={TITLE}>
        <Alert variant="danger">{EXPIRED}</Alert>
      </BrandedAuthPage>
    );
  }

  if (isLoading || !details) {
    return (
      <BrandedAuthPage title={TITLE} subtitle="Please wait...">
        <Spinner size="lg" />
      </BrandedAuthPage>
    );
  }

  // Only a spent or expired link is final; anything else may work on a retry.
  const spent =
    confirm.isError &&
    isAxiosError(confirm.error) &&
    confirm.error.response?.status === 404;
  const failure = confirm.isError ? (spent ? EXPIRED : TRY_AGAIN) : null;

  return (
    <BrandedAuthPage title={TITLE} subtitle={details.email}>
      <Col>
        {failure && <Alert variant="danger">{failure}</Alert>}
        <Button
          fullWidth
          disabled={confirm.isPending || spent}
          onClick={() => confirm.mutate(token)}
        >
          {confirm.isPending ? "Confirming..." : "Confirm my email"}
        </Button>
      </Col>
    </BrandedAuthPage>
  );
};
