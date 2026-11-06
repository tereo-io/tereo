import useGuestOptions from "@/features/auth-admin/api/guests/useGuestOptions";
import useExtendGuest from "@/features/auth-admin/api/guests/useExtendGuest";
import type { User } from "@/features/auth-admin/api/users/types";
import { Button, Col, Modal, Select } from "@kosmeo-ui/react";
import { formatDateTime } from "@/utils/formatDate";
import { useState } from "react";
import {
  defaultDuration,
  expiryAfter,
  guestDurationOptions,
} from "@/features/auth-admin/api/guests/guestDurations";

interface ExtendGuestButtonProps {
  user: User;
}

const ExtendGuestButton = ({ user }: ExtendGuestButtonProps) => {
  const [show, setShow] = useState(false);
  const [duration, setDuration] = useState<string | null>(null);
  const { data: options } = useGuestOptions({ enabled: show });
  const extend = useExtendGuest();

  const max = options?.maxTtlSeconds;
  const durations = guestDurationOptions(max, " from now");
  const seconds =
    duration !== null && durations.some((o) => o.value === duration)
      ? duration
      : defaultDuration(durations);

  const handleSubmit = () => {
    const expiresAt = expiryAfter(Number(seconds), max).toISOString();
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
            disabled={!options}
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
            value={seconds}
            options={durations}
            onChange={(value) => setDuration(value ?? null)}
          />
        </Col>
      </Modal>
    </>
  );
};

export default ExtendGuestButton;
