import type { InviteGuestResult } from "@/features/auth-admin/api/guests/types";
import useInviteGuest from "@/features/auth-admin/api/guests/useInviteGuest";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import { errorCodeOf, errorDescriptionOf } from "@/utils/apiErrors";
import { formatDateTime } from "@/utils/formatDate";
import { useState } from "react";
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Col,
  FormError,
  Input,
  Modal,
  RadioGroup,
  SecretDisplay,
  Select,
} from "@kosmeo-ui/react";

const DAY_SECONDS = 24 * 60 * 60;

const EXPIRY_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

type AccessType = "password_setup_link" | "password";

const inviteErrorMessage = (error: unknown): string => {
  switch (errorCodeOf(error)) {
    case "user_exists":
      return "This person already has an account. Add them to the organization as a member instead.";
    case "guest_in_other_organization":
      return "This person is a guest of another organization.";
    case "organization_not_permitted":
      return "You can invite guests only into an organization you belong to.";
    case "user_not_invitable":
      return "This account cannot be invited as a guest.";
    case "email_not_configured":
      return "Core has no email connection, so it cannot email the link. Turn off emailing to get the link here instead.";
    default:
      return errorDescriptionOf(error, "Failed to invite guest");
  }
};

interface InviteGuestModalProps {
  orgId: string;
  show: boolean;
  onClose: () => void;
}

const InviteGuestModal = ({ orgId, show, onClose }: InviteGuestModalProps) => {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [days, setDays] = useState("30");
  const [access, setAccess] = useState<AccessType>("password_setup_link");
  const [notify, setNotify] = useState(false);
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [result, setResult] = useState<InviteGuestResult | null>(null);

  const { data: allRoles } = useAllRoles();
  const invite = useInviteGuest();

  const assignable = (allRoles ?? []).filter(
    (r) => r.guestAssignable && r.isActive
  );

  const close = () => {
    setEmail("");
    setName("");
    setRoles([]);
    setDays("30");
    setAccess("password_setup_link");
    setNotify(false);
    setPassword("");
    setMustChange(true);
    setResult(null);
    invite.reset();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    invite.mutate(
      {
        email: email.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        organizationId: orgId,
        ...(roles.length > 0 ? { roles } : {}),
        expiresIn: Number(days) * DAY_SECONDS,
        initialAccess:
          access === "password"
            ? { type: "password", password, mustChange }
            : { type: "password_setup_link", notify },
      },
      { onSuccess: setResult }
    );
  };

  if (result) {
    return (
      <Modal
        show={show}
        onClose={close}
        title={result.created ? "Guest Invited" : "Guest Extended"}
        footerButtons={[
          <Button key="done" onClick={close}>
            Done
          </Button>,
        ]}
      >
        <Col>
          <p>
            {result.created
              ? `${result.user.email} was invited`
              : `${result.user.email} already was a guest here; their access was extended`}
            {result.user.expiresAt
              ? ` and has access until ${formatDateTime(result.user.expiresAt)}.`
              : "."}
          </p>
          {result.passwordSetupUrl && (
            <>
              <p>The link to set their password, shown only now:</p>
              <SecretDisplay value={result.passwordSetupUrl} />
            </>
          )}
        </Col>
      </Modal>
    );
  }

  return (
    <Modal
      show={show}
      onClose={close}
      title="Invite Guest"
      footerButtons={[
        <Button
          key="invite"
          type="submit"
          form="invite-guest-form"
          isLoading={invite.isPending}
        >
          Invite Guest
        </Button>,
        <Button
          key="cancel"
          variant="secondary"
          onClick={close}
          disabled={invite.isPending}
        >
          Cancel
        </Button>,
      ]}
    >
      <form id="invite-guest-form" onSubmit={handleSubmit}>
        <Col size="md">
          {invite.isError && (
            <FormError>{inviteErrorMessage(invite.error)}</FormError>
          )}
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            label="Name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
          />
          <Select
            label="Access lasts"
            value={days}
            options={EXPIRY_OPTIONS}
            onChange={(value) => setDays(value ?? "30")}
          />
          {assignable.length > 0 && (
            <CheckboxGroup
              name="guest-roles"
              label="Roles"
              options={assignable.map((r) => ({
                value: r.name,
                label: r.displayName,
              }))}
              values={roles}
              onChange={setRoles}
            />
          )}
          <RadioGroup<AccessType>
            label="Initial access"
            name="initial-access"
            value={access}
            onChange={setAccess}
            options={[
              { value: "password_setup_link", label: "Password setup link" },
              { value: "password", label: "Set a password" },
            ]}
          />
          {access === "password_setup_link" ? (
            <Checkbox
              label="Email the link to the guest"
              labelLocation="right"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
          ) : (
            <>
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
              <Checkbox
                label="Must change at first sign-in"
                labelLocation="right"
                checked={mustChange}
                onChange={(e) => setMustChange(e.target.checked)}
              />
            </>
          )}
        </Col>
      </form>
    </Modal>
  );
};

export default InviteGuestModal;
