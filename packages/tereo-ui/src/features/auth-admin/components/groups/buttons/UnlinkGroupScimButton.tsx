import useUnlinkGroupScim from "../../../api/groups/useUnlinkGroupScim";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { useState } from "react";

interface UnlinkGroupScimButtonProps {
  groupId: string;
  providerName: string;
}

const UnlinkGroupScimButton = ({
  groupId,
  providerName,
}: UnlinkGroupScimButtonProps) => {
  const [confirming, setConfirming] = useState(false);
  const unlink = useUnlinkGroupScim();

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
        Unlink
      </Button>
      <ConfirmationModal
        show={confirming}
        handleHide={() => setConfirming(false)}
        handleConfirm={() =>
          unlink.mutate(groupId, { onSettled: () => setConfirming(false) })
        }
        title="Unlink from SCIM"
        body={`Unlink this group from ${providerName}? Its members stay, and you manage them here from now on. The directory will no longer update it.`}
        confirmButtonText={unlink.isPending ? "Unlinking..." : "Unlink group"}
      />
    </>
  );
};

export default UnlinkGroupScimButton;
