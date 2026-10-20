import RegenerateRecoveryCodesButton from "./buttons/RegenerateRecoveryCodesButton";
import RevokeAllOtherSessionsButton from "./buttons/RevokeAllOtherSessionsButton";
import useAccountSessions from "../../api/account/useAccountSessions";
import useAccountProfile from "../../api/account/useAccountProfile";
import ChangePasswordButton from "./buttons/ChangePasswordButton";
import DisableTotpButton from "./buttons/DisableTotpButton";
import EnableTotpButton from "./buttons/EnableTotpButton";
import { ConnectedAccounts } from "./ConnectedAccounts";
import { PageHeader } from "@/components/PageHeader";
import RevokeButton from "./buttons/RevokeButton";
import ProfilePhoto from "./ProfilePhoto";
import { useState } from "react";
import "../users/sessions.css";
import "./styles.css";
import {
  Alert,
  Badge,
  BorderedSection,
  Card,
  Centered,
  Col,
  EmptyState,
  ListCard,
  Page,
  Row,
  SectionHeader,
  Spinner,
  TagCard,
} from "@kosmeo-ui/react";

export const MyAccountPage = () => {
  const { data: profile, isLoading: profileLoading } = useAccountProfile();
  const { data: sessionsData } = useAccountSessions();
  const [enrollingTotp, setEnrollingTotp] = useState(false);

  if (profileLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!profile) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Failed to load profile</EmptyState>
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader title="My Account" subtitle={profile.email} />
      <Row>
        <Col>
          <Row>
            <ProfilePhoto photoUrl={profile.photoUrl} />
            <Col>
              <ListCard
                listTitle="Account Details"
                items={[
                  { label: "Email", value: profile.email },
                  { label: "Name", value: profile.name || "-" },
                  {
                    label: "Status",
                    value: (
                      <Badge
                        size="sm"
                        subtle={true}
                        variant={profile.isActive ? "success" : "danger"}
                      >
                        {profile.isActive ? "Active" : "Inactive"}
                      </Badge>
                    ),
                  },
                  {
                    label: "Created",
                    value: new Date(profile.createdAt).toLocaleString(),
                  },
                ]}
                footerButtons={
                  // Changing a password needs the current one.
                  profile.hasPassword ? <ChangePasswordButton /> : null
                }
              />
            </Col>
          </Row>
          <Card>
            <SectionHeader
              title="Active Sessions"
              actions={<RevokeAllOtherSessionsButton />}
            />
            {sessionsData?.sessions.length ? (
              <ul className="t-sessions-list">
                {sessionsData.sessions.map((session) => (
                  <li
                    key={session.id}
                    className={
                      session.isCurrent ? "t-session-current" : undefined
                    }
                  >
                    <BorderedSection>
                      <div className="t-session-header">
                        <div>
                          <div className="t-session-client">
                            {session.clientName}
                            {session.isCurrent && (
                              <Badge size="sm">Current</Badge>
                            )}
                          </div>
                          <Col size="sm">
                            <span>
                              Created:
                              {new Date(session.createdAt).toLocaleString()}
                            </span>
                            <span>
                              Expires:
                              {new Date(session.expiresAt).toLocaleString()}
                            </span>
                          </Col>
                        </div>
                        {!session.isCurrent && (
                          <RevokeButton session={session} />
                        )}
                      </div>
                      {session.scopes.length > 0 && (
                        <div className="t-session-scopes">
                          {session.scopes.map((scope) => (
                            <Badge key={scope} size="sm" variant="secondary">
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </BorderedSection>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No active sessions</EmptyState>
            )}
          </Card>
        </Col>
        <Col>
          <ListCard
            listTitle="Two-Factor Authentication"
            items={[
              {
                label: "Status",
                value: (
                  <Badge
                    size="sm"
                    subtle={true}
                    variant={profile.totp.enabled ? "success" : "danger"}
                  >
                    {profile.totp.enabled ? "Enabled" : "Not Enabled"}
                  </Badge>
                ),
              },
              ...(profile.totp.enabled && profile.totp.enabledAt
                ? [
                    {
                      label: "Enabled On",
                      value: new Date(profile.totp.enabledAt).toLocaleString(),
                    },
                  ]
                : []),
              ...(profile.totp.enabled
                ? [
                    {
                      label: "Recovery Codes",
                      value: (
                        <>
                          {profile.totp.recoveryCodesRemaining} remaining
                          {profile.totp.recoveryCodesRemaining <= 2 && (
                            <Alert variant="warning" size="sm">
                              Low - consider regenerating
                            </Alert>
                          )}
                        </>
                      ),
                    },
                  ]
                : []),
              {
                label: "Required",
                value: profile.totp.required ? "Yes" : "No",
              },
            ]}
            footerButtons={
              // Verifying refetches the profile, which enables 2FA before the
              // user has saved the recovery codes; EnableTotpButton holds them,
              // so it stays mounted until its modal closes.
              profile.totp.enabled && !enrollingTotp ? (
                <>
                  <RegenerateRecoveryCodesButton />
                  {/* Core refuses while a role or the policy requires 2FA. */}
                  {!profile.totp.required && <DisableTotpButton />}
                </>
              ) : (
                <EnableTotpButton onOpenChange={setEnrollingTotp} />
              )
            }
          />
          <ConnectedAccounts />
          <TagCard
            title="My Roles"
            tags={profile.roles.map((r) => r.displayName)}
            emptyText="No Roles"
          />
          <TagCard
            title="My Permissions"
            tags={profile.permissions.map((permission) => permission)}
            color="secondary"
            emptyText="No Permissions"
          />
        </Col>
      </Row>
    </Page>
  );
};
