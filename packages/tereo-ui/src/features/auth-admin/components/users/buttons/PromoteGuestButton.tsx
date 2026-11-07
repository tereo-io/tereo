import usePromoteUser from "@/features/auth-admin/api/guests/usePromoteUser";
import type { User } from "@/features/auth-admin/api/users/types";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { useState } from "react";

interface PromoteGuestButtonProps {
  user: User;
}

const PromoteGuestButton = ({ user }: PromoteGuestButtonProps) => {
  const [show, setShow] = useState(false);
  const promote = usePromoteUser();

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setShow(true)}>
        Promote
      </Button>
      <ConfirmationModal
        show={show}
        handleHide={() => setShow(false)}
        handleConfirm={() =>
          promote.mutate(user.id, { onSuccess: () => setShow(false) })
        }
        title="Promote Guest"
        body={`Make "${user.email}" a full user? Their access no longer expires and the guest restrictions on roles lift. Their roles, memberships and history are kept.`}
        confirmButtonText={promote.isPending ? "Promoting..." : "Promote"}
      />
    </>
  );
};

export default PromoteGuestButton;
