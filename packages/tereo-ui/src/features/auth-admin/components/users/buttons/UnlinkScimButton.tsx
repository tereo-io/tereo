import useUnlinkUserScim from "../../../api/users/useUnlinkUserScim";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { useState } from "react";

interface UnlinkScimButtonProps {
  userId: string;
  email: string;
  providerName: string;
}

const UnlinkScimButton = ({
  userId,
  email,
  providerName,
}: UnlinkScimButtonProps) => {
  const [confirming, setConfirming] = useState(false);
  const unlink = useUnlinkUserScim();

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
        Unlink
      </Button>
      <ConfirmationModal
        show={confirming}
        handleHide={() => setConfirming(false)}
        handleConfirm={() =>
          unlink.mutate(userId, { onSettled: () => setConfirming(false) })
        }
        title="Unlink from SCIM"
        body={`Unlink ${email} from ${providerName}? ${providerName} stops managing this user, and their name and email can be edited here.`}
        confirmButtonText={unlink.isPending ? "Unlinking..." : "Unlink user"}
      />
    </>
  );
};

export default UnlinkScimButton;
