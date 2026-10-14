import useCreateBucket from "@/features/file-storage/api/buckets/useCreateBucket";
import { useState } from "react";
import "../styles.css";
import type {
  CreateBucketInput,
  Bucket,
} from "@/features/file-storage/api/buckets/types";
import {
  Button,
  Col,
  FormError,
  Input,
  Modal,
  Select,
  TextArea,
} from "@kosmeo-ui/react";

interface CreateBucketModalProps {
  show: boolean;
  onCreate: (bucket: Bucket) => void;
  onClose: () => void;
}

const CreateBucketModal = ({
  show,
  onCreate,
  onClose,
}: CreateBucketModalProps) => {
  const { mutate: createBucket, isPending } = useCreateBucket();
  const [formData, setFormData] = useState<CreateBucketInput>({
    name: "",
    description: "",
    policy: "private",
  });
  const [nameError, setNameError] = useState<string>("");

  const validateBucketName = (name: string): boolean => {
    if (name.length < 3 || name.length > 63) {
      setNameError("Bucket name must be 3-63 characters");
      return false;
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
      setNameError(
        "Bucket name must start and end with alphanumeric, contain only lowercase letters, numbers, and hyphens"
      );
      return false;
    }
    setNameError("");
    return true;
  };

  const handleSubmit = () => {
    if (!validateBucketName(formData.name)) {
      return;
    }

    const payload: CreateBucketInput = {
      name: formData.name,
      policy: formData.policy,
    };

    if (formData.description) {
      payload.description = formData.description;
    }

    createBucket(payload, {
      onSuccess: (bucket) => {
        setFormData({ name: "", description: "", policy: "private" });
        setNameError("");
        onCreate(bucket);
      },
    });
  };

  const handleClose = () => {
    setFormData({ name: "", description: "", policy: "private" });
    setNameError("");
    onClose();
  };

  return (
    <Modal
      show={show}
      onClose={handleClose}
      title="Create Bucket"
      footerButtons={[
        <Button
          key="create"
          onClick={handleSubmit}
          isLoading={isPending}
          disabled={isPending}
        >
          Create
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
      <Col>
        <Input
          label="Bucket Name"
          value={formData.name}
          onChange={(e) => {
            setFormData({ ...formData, name: e.target.value });
            setNameError("");
          }}
          required
          placeholder="my-bucket-name"
        />
        {nameError && <FormError>{nameError}</FormError>}
        <TextArea
          label="Description"
          value={formData.description}
          onChange={(e) =>
            setFormData({ ...formData, description: e.target.value })
          }
          placeholder="Optional description"
          rows={3}
        />
        <Select
          label="Policy"
          value={formData.policy}
          onChange={(value) =>
            setFormData({
              ...formData,
              policy: value as "public" | "private",
            })
          }
          options={[
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
        />
      </Col>
    </Modal>
  );
};

export default CreateBucketModal;
