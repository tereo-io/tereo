import useAddGroupMembers from "@/features/auth-admin/api/groups/useAddGroupMembers";
import { Badge, Button, Col, FormError, Input, Modal } from "@kosmeo-ui/react";
import type { UserListItem } from "@/features/auth-admin/types/user";
import UserTypeahead from "../../users/UserTypeahead";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface AddMembersModalProps {
  groupId: string;
  /** Ids already in the group; core skips them, but picking one is a slip. */
  memberIds: string[];
  show: boolean;
  onAdd: () => void;
  onClose: () => void;
}

// Core takes up to 500 ids per request.
const MAX_USERS = 500;

const AddMembersModal = ({
  groupId,
  memberIds,
  show,
  onAdd,
  onClose,
}: AddMembersModalProps) => {
  const { hasPermission } = useAuth();
  const { mutate: addMembers, isPending } = useAddGroupMembers(groupId);
  // Searching users is `/v1/admin/users`, which needs users.read. An
  // organization admin without it enters ids; core checks them.
  const canSearchUsers = hasPermission("users.read");
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const [manualUserId, setManualUserId] = useState("");
  const [selected, setSelected] = useState<UserListItem | null>(null);
  const [error, setError] = useState("");

  const reset = () => {
    setPicked([]);
    setManualUserId("");
    setSelected(null);
    setError("");
  };

  const pick = (id: string, label: string) => {
    if (memberIds.includes(id)) {
      setError("Already a member of this group");
    } else if (picked.length >= MAX_USERS) {
      setError(`Add up to ${MAX_USERS} users at a time`);
    } else if (!picked.some((p) => p.id === id)) {
      setPicked([...picked, { id, label }]);
      setError("");
    }
  };

  const handleSubmit = () => {
    if (picked.length === 0) {
      setError("Pick at least one user");
      return;
    }
    addMembers(
      picked.map((p) => p.id),
      {
        onSuccess: () => {
          reset();
          onAdd();
        },
      }
    );
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Modal
      show={show}
      onClose={handleClose}
      title="Add Members"
      footerButtons={[
        <Button
          key="add"
          onClick={handleSubmit}
          isLoading={isPending}
          disabled={isPending}
        >
          Add Members
        </Button>,
        <Button
          key="cancel"
          variant="secondary"
          onClick={handleClose}
          disabled={isPending}
        >
          Cancel
        </Button>,
      ]}
    >
      <Col size="md">
        {canSearchUsers ? (
          <UserTypeahead
            label="Add a user"
            value={selected}
            onSelect={(user) => {
              // The picked user moves to the list below; the search clears.
              if (user) pick(user.id, user.email);
              setSelected(null);
            }}
          />
        ) : (
          <>
            <Input
              label="User ID"
              value={manualUserId}
              onChange={(e) => {
                setManualUserId(e.target.value);
                setError("");
              }}
              placeholder="User UUID"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!manualUserId.trim()}
              onClick={() => {
                pick(manualUserId.trim(), manualUserId.trim());
                setManualUserId("");
              }}
            >
              Add to list
            </Button>
          </>
        )}
        {error && <FormError>{error}</FormError>}
        {picked.length > 0 && (
          <div className="t-group-picked">
            {picked.map((p) => (
              <Badge key={p.id} variant="secondary">
                {p.label}{" "}
                <button
                  type="button"
                  className="t-group-picked-remove"
                  aria-label={`Remove ${p.label}`}
                  onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
      </Col>
    </Modal>
  );
};

export default AddMembersModal;
