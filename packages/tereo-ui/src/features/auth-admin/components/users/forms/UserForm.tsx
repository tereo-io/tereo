import { Col, Form, Input, Select } from "@kosmeo-ui/react";
import { useState } from "react";
import type {
  User,
  CreateUserInput,
  UpdateUserInput,
} from "@/features/auth-admin/api/users/types";

interface UserFormProps {
  user?: User;
  onSubmit: (data: CreateUserInput | UpdateUserInput) => void;
  formId?: string;
}

export const UserForm = ({ user, onSubmit, formId }: UserFormProps) => {
  const [email, setEmail] = useState(user?.email || "");
  const [name, setName] = useState(user?.name || "");
  const [password, setPassword] = useState("");
  const [isActive, setIsActive] = useState(
    user ? String(user.isActive) : "true"
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (user) {
      // Update mode - only send changed fields
      const updates: UpdateUserInput = {};
      if (email !== user.email) updates.email = email;
      if (name !== (user.name || "")) updates.name = name;
      if (password) updates.password = password;
      if (String(user.isActive) !== isActive)
        updates.isActive = isActive === "true";
      onSubmit(updates);
    } else {
      // Create mode
      onSubmit({
        userType: "human",
        email,
        password: password || undefined,
        name: name || undefined,
      });
    }
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
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
        <Input
          label={user ? "New Password" : "Password"}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={
            user
              ? "Leave blank to keep current"
              : "Leave blank for sign-in through a provider only"
          }
        />
        {user && (
          <Select
            label="Status"
            value={isActive}
            options={[
              { value: "true", label: "Active" },
              { value: "false", label: "Inactive" },
            ]}
            onChange={(value) => setIsActive(value ?? "false")}
          />
        )}
      </Col>
    </Form>
  );
};
