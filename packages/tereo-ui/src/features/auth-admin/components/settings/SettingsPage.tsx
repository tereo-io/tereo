import useUpdateSettings from "../../api/settings/useUpdateSettings";
import type { TotpPolicy } from "../../api/settings/types";
import useSettings from "../../api/settings/useSettings";
import { PageHeader } from "@/components/PageHeader";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  Alert,
  Button,
  Card,
  Centered,
  EmptyState,
  FormActions,
  Page,
  Row,
  Select,
  Spinner,
} from "@kosmeo-ui/react";

const TOTP_POLICY_OPTIONS = [
  { value: "disabled", label: "Disabled - 2FA not available" },
  { value: "optional", label: "Optional - Users can enable 2FA" },
  { value: "required", label: "Required - All users must use 2FA" },
];

const RECOVERY_CODE_OPTIONS = [
  { value: "6", label: "6 codes" },
  { value: "8", label: "8 codes" },
  { value: "10", label: "10 codes" },
  { value: "12", label: "12 codes" },
];

export const SettingsPage = () => {
  const { data: settings, isLoading, error } = useSettings();
  const updateMutation = useUpdateSettings();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("settings.write");

  const [totpPolicy, setTotpPolicy] = useState<TotpPolicy>("optional");
  const [recoveryCodeCount, setRecoveryCodeCount] = useState("10");
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (settings) {
      setTotpPolicy(settings.totpPolicy);
      setRecoveryCodeCount(String(settings.totpRecoveryCodeCount));
    }
  }, [settings]);

  useEffect(() => {
    if (settings) {
      const policyChanged = totpPolicy !== settings.totpPolicy;
      const countChanged =
        parseInt(recoveryCodeCount, 10) !== settings.totpRecoveryCodeCount;
      setHasChanges(policyChanged || countChanged);
    }
  }, [totpPolicy, recoveryCodeCount, settings]);

  const handleSave = () => {
    updateMutation.mutate({
      totpPolicy,
      totpRecoveryCodeCount: parseInt(recoveryCodeCount, 10),
    });
  };

  const handleReset = () => {
    if (settings) {
      setTotpPolicy(settings.totpPolicy);
      setRecoveryCodeCount(String(settings.totpRecoveryCodeCount));
    }
  };

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (error) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Failed to load settings</EmptyState>
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader
        title="Settings"
        subtitle="Configure global system settings"
      />

      <Card>
        <h3>Two-Factor Authentication</h3>
        <p className="v-help-text">
          Configure how two-factor authentication is handled across the system.
          Individual roles can also require 2FA for their members.
        </p>

        <Row>
          <div className="t-settings-field">
            <Select
              label="2FA Policy"
              value={totpPolicy}
              onChange={(value) => value && setTotpPolicy(value as TotpPolicy)}
              options={TOTP_POLICY_OPTIONS}
              disabled={!canWrite}
            />
            <p className="v-help-text">
              {totpPolicy === "disabled" &&
                "Users cannot enable two-factor authentication."}
              {totpPolicy === "optional" &&
                "Users can choose to enable two-factor authentication."}
              {totpPolicy === "required" &&
                "All users must set up two-factor authentication during their next login."}
            </p>
          </div>
          <div className="t-settings-field">
            <Select
              label="Recovery Code Count"
              value={recoveryCodeCount}
              onChange={(value) => value && setRecoveryCodeCount(value)}
              options={RECOVERY_CODE_OPTIONS}
              disabled={!canWrite}
            />
            <p className="v-help-text">
              Number of one-time recovery codes generated when a user sets up
              2FA. This applies to new setups and regenerations.
            </p>
          </div>
        </Row>

        {updateMutation.isSuccess && (
          <Alert variant="success">Settings saved successfully</Alert>
        )}

        {updateMutation.isError && (
          <Alert variant="danger">Failed to save settings</Alert>
        )}

        {canWrite && (
          <FormActions align="left" spacing="lg">
            <Button
              variant="secondary"
              onClick={handleReset}
              disabled={!hasChanges || updateMutation.isPending}
            >
              Reset
            </Button>
            <Button
              onClick={handleSave}
              disabled={!hasChanges}
              isLoading={updateMutation.isPending}
            >
              Save Changes
            </Button>
          </FormActions>
        )}
      </Card>
    </Page>
  );
};
