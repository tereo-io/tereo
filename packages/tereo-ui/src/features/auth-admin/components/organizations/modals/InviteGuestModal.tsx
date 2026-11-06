import { inviteGuestErrorMessage } from "@/features/auth-admin/api/guests/guestErrors";
import type { InviteGuestResult } from "@/features/auth-admin/api/guests/types";
import useGuestOptions from "@/features/auth-admin/api/guests/useGuestOptions";
import useInviteGuest from "@/features/auth-admin/api/guests/useInviteGuest";
import { formatDateTime } from "@/utils/formatDate";
import { useState } from "react";
import {
  defaultDuration,
  guestDurationOptions,
} from "@/features/auth-admin/api/guests/guestDurations";
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

type AccessType = "password_setup_link" | "password";

interface InviteGuestModalProps {
  /** The organization to invite into; without it, one is picked from `organizations`. */
  orgId?: string;
  organizations?: { id: string; name: string }[];
  show: boolean;
  onClose: () => void;
}

const InviteGuestModal = ({
  orgId,
  organizations = [],
  show,
  onClose,
}: InviteGuestModalProps) => {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pickedOrgId, setPickedOrgId] = useState<string | null>(null);
  // Null until touched: the defaults show checked, and core applies them
  // when `roles` is left out.
  const [roles, setRoles] = useState<string[] | null>(null);
  const [duration, setDuration] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessType>("password_setup_link");
  const [notify, setNotify] = useState(false);
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [result, setResult] = useState<InviteGuestResult | null>(null);

  const { data: options } = useGuestOptions({ enabled: show });
  const invite = useInviteGuest();

  const assignable = options?.roles ?? [];
  const selectedRoles = roles ?? options?.defaultRoleIds ?? [];
  const durations = guestDurationOptions(options?.maxTtlSeconds);
  const expiresIn =
    duration !== null && durations.some((o) => o.value === duration)
      ? duration
      : defaultDuration(durations);
  const organizationId =
    orgId ??
    pickedOrgId ??
    (organizations.length === 1 ? organizations[0].id : "");

  const close = () => {
    setEmail("");
    setName("");
    setPickedOrgId(null);
    setRoles(null);
    setDuration(null);
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
        organizationId,
        ...(roles !== null ? { roles } : {}),
        expiresIn: Number(expiresIn),
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
          disabled={!options}
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
            <FormError>{inviteGuestErrorMessage(invite.error)}</FormError>
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
          {orgId === undefined && (
            <Select
              label="Organization"
              value={organizationId || undefined}
              placeholder="Choose an organization"
              options={organizations.map((o) => ({
                value: o.id,
                label: o.name,
              }))}
              onChange={(value) => setPickedOrgId(value ?? null)}
              required
            />
          )}
          <Select
            label="Access lasts"
            value={expiresIn}
            options={durations}
            onChange={(value) => setDuration(value ?? null)}
          />
          {assignable.length > 0 && (
            <CheckboxGroup
              name="guest-roles"
              label="Roles"
              options={assignable.map((r) => ({
                value: r.id,
                label: r.displayName,
              }))}
              values={selectedRoles}
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
