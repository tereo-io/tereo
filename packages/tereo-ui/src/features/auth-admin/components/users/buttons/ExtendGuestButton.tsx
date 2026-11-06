import useExtendGuest from "@/features/auth-admin/api/guests/useExtendGuest";
import type { User } from "@/features/auth-admin/api/users/types";
import { Button, Col, Modal, Select } from "@kosmeo-ui/react";
import { formatDateTime } from "@/utils/formatDate";
import { useState } from "react";

const DAY_SECONDS = 24 * 60 * 60;

export const EXTEND_OPTIONS = [
  { value: "7", label: "7 days from now" },
  { value: "30", label: "30 days from now" },
  { value: "90", label: "90 days from now" },
];

interface ExtendGuestButtonProps {
  user: User;
}

const ExtendGuestButton = ({ user }: ExtendGuestButtonProps) => {
  const [show, setShow] = useState(false);
  const [days, setDays] = useState("30");
  const extend = useExtendGuest();

  const handleSubmit = () => {
    const expiresAt = new Date(
      Date.now() + Number(days) * DAY_SECONDS * 1000
    ).toISOString();
    extend.mutate(
      { id: user.id, expiresAt },
      { onSuccess: () => setShow(false) }
    );
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setShow(true)}>
        Extend
      </Button>
      <Modal
        show={show}
        onClose={() => setShow(false)}
        title="Extend Guest Access"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShow(false)}
          >
            Cancel
          </Button>,
          <Button
            key="save"
            onClick={handleSubmit}
            isLoading={extend.isPending}
          >
            Set expiry
          </Button>,
        ]}
      >
        <Col>
          <p>
            {user.expiresAt
              ? `Access currently ends ${formatDateTime(user.expiresAt)}.`
              : "This guest has no expiry set."}
          </p>
          <Select
            label="New expiry"
            value={days}
            options={EXTEND_OPTIONS}
            onChange={(value) => setDays(value ?? "30")}
          />
        </Col>
      </Modal>
    </>
  );
};

export default ExtendGuestButton;
