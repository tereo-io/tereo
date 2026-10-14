import useCreateConnection from "../../api/connections/useCreateConnection";
import useUpdateConnection from "../../api/connections/useUpdateConnection";
import { issuesOf, type CoreError } from "../../api/errorMessage";
import type { NotificationConnection } from "../../api/types";
import useChannels from "../../api/connections/useChannels";
import { Alert, Button, Modal } from "@kosmeo-ui/react";
import {
  EmailConnectionForm,
  type ConnectionFormValues,
} from "./EmailConnectionForm";

interface ConnectionFormModalProps {
  show: boolean;
  /** Absent to create. */
  connection?: NotificationConnection;
  onClose: () => void;
}

const FORM_ID = "notification-connection-form";

const enumOf = (schema: Record<string, unknown> | undefined, key: string) => {
  const props = schema?.properties as
    Record<string, { enum?: unknown }> | undefined;
  const values = props?.[key]?.enum;
  return Array.isArray(values) ? (values as string[]) : undefined;
};

/** Email is the only channel with a form; a new channel adds its own beside it. */
export const ConnectionFormModal = ({
  show,
  connection,
  onClose,
}: ConnectionFormModalProps) => {
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const { data: channels } = useChannels();
  const mutation = connection ? update : create;

  const settingsSchema = channels?.find(
    (c) => c.channel === "email"
  )?.settingsSchema;

  const close = () => {
    create.reset();
    update.reset();
    onClose();
  };

  const submit = (values: ConnectionFormValues) => {
    const { slug, secrets, ...rest } = values;
    if (connection) {
      update.mutate(
        { id: connection.id, data: { ...rest, secrets } },
        { onSuccess: close }
      );
    } else {
      create.mutate(
        {
          channel: "email",
          slug: slug ?? "",
          ...rest,
          ...(secrets && { secrets }),
        },
        { onSuccess: close }
      );
    }
  };

  return (
    <Modal
      show={show}
      onClose={close}
      title={
        connection ? `Edit ${connection.displayName}` : "New email connection"
      }
      size="lg"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={close}>
          Cancel
        </Button>,
        <Button
          key="save"
          type="submit"
          form={FORM_ID}
          isLoading={mutation.isPending}
        >
          {connection ? "Save" : "Create connection"}
        </Button>,
      ]}
    >
      {connection && connection.channel !== "email" ? (
        <Alert variant="warning">
          The admin UI has no form for the {connection.channel} channel yet.
        </Alert>
      ) : (
        // Remounts per opening so a cancelled draft doesn't linger.
        show && (
          <EmailConnectionForm
            formId={FORM_ID}
            connection={connection}
            onSubmit={submit}
            issues={issuesOf(mutation.error as CoreError | null)}
            securityOptions={enumOf(settingsSchema, "security")}
          />
        )
      )}
    </Modal>
  );
};
