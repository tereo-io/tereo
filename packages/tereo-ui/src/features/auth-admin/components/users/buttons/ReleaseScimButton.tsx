import useReleaseUserScim from "../../../api/users/useReleaseUserScim";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { useState } from "react";

interface ReleaseScimButtonProps {
  userId: string;
  email: string;
  providerName: string;
}

const ReleaseScimButton = ({
  userId,
  email,
  providerName,
}: ReleaseScimButtonProps) => {
  const [confirming, setConfirming] = useState(false);
  const release = useReleaseUserScim();

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
        Allow SCIM again
      </Button>
      <ConfirmationModal
        show={confirming}
        handleHide={() => setConfirming(false)}
        handleConfirm={() =>
          release.mutate(userId, { onSettled: () => setConfirming(false) })
        }
        title="Allow SCIM again"
        body={`Allow ${providerName} to manage ${email} again? Its next update takes the user over, and it can sign in as them.`}
        confirmButtonText={release.isPending ? "Allowing..." : "Allow SCIM"}
      />
    </>
  );
};

export default ReleaseScimButton;
