import useClearReportsTo from "../../../api/users/useClearReportsTo";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import type { UserDetail } from "../../../api/users/types";
import { useState } from "react";

interface ClearReportsToButtonProps {
  user: UserDetail;
}

const ClearReportsToButton = ({ user }: ClearReportsToButtonProps) => {
  const [confirming, setConfirming] = useState(false);
  const clear = useClearReportsTo();

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
        Clear
      </Button>
      <ConfirmationModal
        show={confirming}
        handleHide={() => setConfirming(false)}
        handleConfirm={() =>
          clear.mutate(
            { id: user.id, previousManagerId: user.reportsTo?.id },
            { onSettled: () => setConfirming(false) }
          )
        }
        title="Clear reporting line"
        body={`Remove ${user.email}'s reporting line?`}
        confirmButtonText={clear.isPending ? "Removing..." : "Remove"}
      />
    </>
  );
};

export default ClearReportsToButton;
