import { useNavigate, useSearchParams } from "react-router-dom";
import { authorizeRestartUrl } from "../api/oauthParams";
import { Button } from "@kosmeo-ui/react";
import env from "@/lib/env";

interface BackToSignInProps {
  /** Where to go when the page carries no authorize request to restart. */
  href?: string;
}

/**
 * The way out of a login flow that cannot continue: back to the sign-in of
 * the client that began it, else `href`, else this app's own.
 */
export const BackToSignIn = ({ href }: BackToSignInProps) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const target = authorizeRestartUrl(env.CORE_URL, searchParams) ?? href;

  const handleClick = () => {
    if (target) window.location.assign(target);
    else navigate("/", { replace: true });
  };

  return (
    <Button onClick={handleClick} fullWidth>
      Back to sign in
    </Button>
  );
};
