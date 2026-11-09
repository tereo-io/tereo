import useSendVerificationEmail from "../../../api/users/useSendVerificationEmail";
import { Button } from "@kosmeo-ui/react";

const SendVerificationEmailButton = ({ userId }: { userId: string }) => {
  const send = useSendVerificationEmail();
  return (
    <Button
      variant="secondary"
      size="sm"
      isLoading={send.isPending}
      onClick={() => send.mutate(userId)}
    >
      Send verification email
    </Button>
  );
};

export default SendVerificationEmailButton;
