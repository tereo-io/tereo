import type { UserListItem } from "@/features/auth-admin/types/user";
import useSetReportsTo from "../../../api/users/useSetReportsTo";
import type { UserDetail } from "../../../api/users/types";
import { Button, Modal } from "@kosmeo-ui/react";
import UserTypeahead from "../UserTypeahead";
import { useState } from "react";

interface ChangeReportsToButtonProps {
  user: UserDetail;
}

const ChangeReportsToButton = ({ user }: ChangeReportsToButtonProps) => {
  const [show, setShow] = useState(false);
  const [manager, setManager] = useState<UserListItem | null>(null);
  const setReportsTo = useSetReportsTo();

  const close = () => {
    setShow(false);
    setManager(null);
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setShow(true)}>
        Change
      </Button>
      <Modal
        show={show}
        onClose={close}
        title={`Who does ${user.email} report to?`}
        footerButtons={[
          <Button key="cancel" variant="secondary" onClick={close}>
            Cancel
          </Button>,
          <Button
            key="save"
            disabled={!manager}
            isLoading={setReportsTo.isPending}
            onClick={() =>
              manager &&
              setReportsTo.mutate(
                {
                  id: user.id,
                  managerId: manager.id,
                  previousManagerId: user.reportsTo?.id,
                },
                { onSuccess: close }
              )
            }
          >
            Save
          </Button>,
        ]}
      >
        <UserTypeahead
          label="Reports to"
          value={manager}
          onSelect={setManager}
        />
      </Modal>
    </>
  );
};

export default ChangeReportsToButton;
