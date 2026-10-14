import { startLogin } from "@/lib/auth/pkce";
import { Button } from "@kosmeo-ui/react";

const LoginButton = () => (
  <Button onClick={() => startLogin()} fullWidth={true}>
    Sign in to Tereo
  </Button>
);

export default LoginButton;
