import { Button, Input, Spinner } from "@kosmeo-ui/react";
import { useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { usePublicAxios } from "@/lib/auth";
import { AxiosError } from "axios";
import "./SharedPage.css";

type PageState =
  | { kind: "resolving" }
  | { kind: "password-required" }
  | { kind: "downloading" }
  | { kind: "not-found" }
  | { kind: "rate-limited" }
  | { kind: "error"; message: string };

/**
 * Public share-consumption page at `/shared/:token` (and
 * `/shared/:token/:filename`, whose cosmetic suffix core forwards), outside
 * the authenticated layout — recipients are typically external users.
 *
 * Share URLs point at core (`${FILE_SERVICE_PUBLIC_BASE_URL}/shared/:token`,
 * i.e. `/v1/files/shared/...`). Core sends browsers here only for
 * password-protected shares (to `FILE_SERVICE_SHARE_UI_BASE_URL`, default
 * `UI_BASE_URL`); the page also works when opened directly.
 *
 * Flow:
 * 1. On mount, HEAD `/v1/files/shared/:token`: core's status probe, which
 *    counts no download and mints no URL. A password share answers `401`.
 * 2. An open share: navigate to the share URL itself, whose GET counts the
 *    download and 302s the browser to a short-lived signed URL. Following
 *    that redirect with `fetch` first would spend a capped share's signed
 *    URL, which serves one request.
 * 3. Password form → POST `/v1/files/shared/:token/unlock` → `{ url }` → navigate.
 * 4. 404 (core's uniform answer for missing/revoked/expired/exhausted) →
 *    not-found; 429 → rate-limited.
 */
const SharedPage = () => {
  const { token } = useParams<{ token: string }>();
  const axios = usePublicAxios("fileService");
  const [state, setState] = useState<PageState>({ kind: "resolving" });
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ kind: "not-found" });
      return;
    }
    const baseUrl = (axios.defaults.baseURL ?? window.location.origin).replace(
      /\/+$/,
      ""
    );
    const shareUrl = `${baseUrl}/shared/${encodeURIComponent(token)}`;
    const controller = new AbortController();
    fetch(shareUrl, { method: "HEAD", signal: controller.signal })
      .then((res) => {
        if (res.ok) {
          setState({ kind: "downloading" });
          window.location.replace(shareUrl);
          return;
        }
        if (res.status === 401) {
          setState({ kind: "password-required" });
          return;
        }
        if (res.status === 404 || res.status === 410) {
          setState({ kind: "not-found" });
          return;
        }
        if (res.status === 429) {
          setState({ kind: "rate-limited" });
          return;
        }
        setState({
          kind: "error",
          message: `Unexpected response (${res.status})`,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, [axios, token]);

  const submitPassword = async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      const res = await axios.post<{ url: string }>(
        `/shared/${encodeURIComponent(token)}/unlock`,
        { password }
      );
      setState({ kind: "downloading" });
      window.location.replace(res.data.url);
    } catch (err) {
      const ax = err as AxiosError;
      if (ax.response?.status === 429) {
        setState({ kind: "rate-limited" });
      } else if (ax.response?.status === 404 || ax.response?.status === 410) {
        setState({ kind: "not-found" });
      } else if (ax.response?.status === 401) {
        setState({ kind: "password-required" });
        setPassword("");
      } else {
        setState({ kind: "error", message: ax.message });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="t-shared-page">
      <div className="t-shared-card">
        {state.kind === "resolving" && (
          <div className="t-shared-resolving">
            <Spinner />
            <p>Loading shared file…</p>
          </div>
        )}
        {state.kind === "password-required" && (
          <div className="t-shared-password-form">
            <div>
              <h2 className="t-shared-password-heading">Enter password</h2>
              <p className="t-shared-password-subtext">
                This share is password-protected.
              </p>
            </div>
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPassword();
              }}
              autoFocus
            />
            <Button
              onClick={submitPassword}
              isLoading={submitting}
              disabled={submitting || !password}
              fullWidth
            >
              Unlock
            </Button>
          </div>
        )}
        {state.kind === "downloading" && (
          <>
            <h2 className="t-shared-state-heading">Downloading</h2>
            <p>Your download should start shortly.</p>
          </>
        )}
        {state.kind === "not-found" && (
          <>
            <h2 className="t-shared-state-heading">Link unavailable</h2>
            <p>
              This share link is invalid, expired, revoked, or has reached its
              download limit.
            </p>
          </>
        )}
        {state.kind === "rate-limited" && (
          <>
            <h2 className="t-shared-state-heading">Too many attempts</h2>
            <p>Please wait a few minutes before trying again.</p>
          </>
        )}
        {state.kind === "error" && (
          <>
            <h2 className="t-shared-state-heading">Something went wrong</h2>
            <p>{state.message}</p>
          </>
        )}
      </div>
    </div>
  );
};

export default SharedPage;
