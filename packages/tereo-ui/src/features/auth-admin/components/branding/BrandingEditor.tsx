import useDeleteBrandingProfile from "../../api/branding/useDeleteBrandingProfile";
import { TEXT_LIMITS, validateDraft } from "../../api/branding/brandingErrors";
import useSaveBrandingProfile from "../../api/branding/useSaveBrandingProfile";
import useBrandingProfile from "../../api/branding/useBrandingProfile";
import useBrandingList from "../../api/branding/useBrandingList";
import { useBlocker, useNavigate } from "react-router-dom";
import { ProvisionedDialog } from "./ProvisionedDialog";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import { CORE_LOGIN_CLIENT_ID } from "../../constants";
import { emptyDraft } from "../../api/branding/types";
import { FooterLinksField } from "./FooterLinksField";
import { PageHeader } from "@/components/PageHeader";
import { BrandingPreview } from "./BrandingPreview";
import { useStockColors } from "@/features/auth";
import { GrantsPanel } from "./GrantsPanel";
import { ColorFields } from "./ColorFields";
import { ImageField } from "./ImageField";
import { useMemo, useState } from "react";
import "./styles.css";
import type {
  AdminProfileBody,
  BrandingDraft,
  BrandingImageSlot,
  BrandingProfile,
  BrandingTarget,
  BrandingTextSlot,
} from "../../api/branding/types";
import {
  Alert,
  Button,
  Centered,
  Checkbox,
  ConfirmationModal,
  EmptyState,
  Input,
  Page,
  Select,
  Spinner,
} from "@kosmeo-ui/react";

const TEXT_FIELDS: { slot: BrandingTextSlot; label: string }[] = [
  { slot: "appName", label: "App name" },
  { slot: "headline", label: "Headline" },
  { slot: "subtitle", label: "Subtitle" },
  { slot: "signInLabel", label: "Sign-in button label" },
  { slot: "notice", label: "Notice" },
];

const IMAGE_FIELDS: { slot: BrandingImageSlot; label: string }[] = [
  { slot: "logo", label: "Logo" },
  { slot: "logoDark", label: "Dark logo" },
  { slot: "favicon", label: "Favicon" },
  { slot: "background", label: "Background image" },
];

const blankToNull = (v: string | null) => (v?.trim() ? v.trim() : null);

/** The full PUT body: core replaces the whole profile. */
const toBody = (draft: BrandingDraft): AdminProfileBody => ({
  appName: blankToNull(draft.appName),
  headline: blankToNull(draft.headline),
  subtitle: blankToNull(draft.subtitle),
  signInLabel: blankToNull(draft.signInLabel),
  notice: blankToNull(draft.notice),
  layout: draft.layout,
  footerLinks: draft.footerLinks?.length
    ? draft.footerLinks.map((l) => ({
        label: l.label.trim(),
        url: l.url.trim(),
      }))
    : null,
  colorsLight: draft.colorsLight,
  colorsDark: draft.colorsDark,
  applyToConsole: draft.applyToConsole,
  logo: draft.logo && { sha256: draft.logo.sha256 },
  logoDark: draft.logoDark && { sha256: draft.logoDark.sha256 },
  favicon: draft.favicon && { sha256: draft.favicon.sha256 },
  background: draft.background && { sha256: draft.background.sha256 },
});

interface FormProps {
  target: BrandingTarget;
  profile: BrandingProfile;
}

const EditorForm = ({ target, profile }: FormProps) => {
  const navigate = useNavigate();
  const initial = useMemo<BrandingDraft>(
    () => profile.own ?? emptyDraft(),
    [profile]
  );
  const [draft, setDraft] = useState<BrandingDraft>(initial);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [showProvisioned, setShowProvisioned] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const save = useSaveBrandingProfile(target);
  const remove = useDeleteBrandingProfile(target);

  const locked = profile.provisioned || !profile.canEdit;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const hasErrors = Object.keys(errors).length > 0;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname
  );

  const patch = (changes: Partial<BrandingDraft>) =>
    setDraft((d) => ({ ...d, ...changes }));

  const appliesToConsole =
    target.kind === "default" ||
    profile.client?.clientId === CORE_LOGIN_CLIENT_ID;
  // The console reads tereo-ui's profile before the default's.
  const { data: list } = useBrandingList({
    enabled: target.kind === "default",
  });
  const consoleHasOwnProfile =
    target.kind === "default" &&
    !!list?.clients.some((c) => c.clientId === CORE_LOGIN_CLIENT_ID);

  const inheritedText = (slot: BrandingTextSlot) =>
    profile.inherited?.[slot] ?? undefined;

  const title =
    target.kind === "default"
      ? "Default branding"
      : `${profile.client?.name ?? "Client"} branding`;

  const actions = locked
    ? profile.provisioned
      ? [
          <Button
            key="edit"
            variant="secondary"
            onClick={() => setShowProvisioned(true)}
          >
            Edit
          </Button>,
        ]
      : []
    : [
        <Button
          key="discard"
          variant="secondary"
          disabled={!dirty}
          onClick={() => setDraft(initial)}
        >
          Discard
        </Button>,
        <Button
          key="save"
          isLoading={save.isPending}
          disabled={!dirty || hasErrors}
          onClick={() => save.mutate(toBody(draft))}
        >
          Save
        </Button>,
        ...(profile.own
          ? [
              <Button
                key="delete"
                variant="danger"
                onClick={() => setShowDelete(true)}
              >
                Remove branding
              </Button>,
            ]
          : []),
      ];

  // Where each colour's placeholder value comes from: the layer that supplies it
  // when the profile doesn't, else the default profile if it has one.
  const placeholderSources = (key: "colorsLight" | "colorsDark") => {
    const reported =
      profile.colorSources?.[key === "colorsLight" ? "light" : "dark"] ?? {};
    return Object.fromEntries(
      Object.keys(profile.inherited?.[key] ?? {}).map((token) => [
        token,
        reported[token] && reported[token] !== "client"
          ? reported[token]
          : "default",
      ])
    );
  };

  const mk = (key: "colorsLight" | "colorsDark") => (
    <ColorFields
      value={draft[key]}
      onChange={(v) => patch({ [key]: v })}
      inherited={profile.inherited?.[key] ?? {}}
      sources={placeholderSources(key)}
      errors={errors}
      errorPrefix={key}
      readOnly={locked}
    />
  );

  return (
    <Page padded fillHeight>
      <PageHeader
        title={title}
        subtitle={
          target.kind === "default"
            ? "Applies to every client without its own branding"
            : profile.client?.clientId
        }
        actions={actions}
      />
      {profile.provisioned && (
        <div className="t-branding-banner">
          <Alert variant="secondary">
            This branding is managed by provisioning
            {profile.provisionedFrom ? ` (${profile.provisionedFrom})` : ""} and
            is read-only here.
          </Alert>
        </div>
      )}
      {!profile.provisioned && !profile.canEdit && (
        <div className="t-branding-banner">
          <Alert variant="secondary">
            You can view this branding but not change it.
          </Alert>
        </div>
      )}
      <div className="t-branding-layout">
        <div className="t-branding-form">
          <section>
            <h2>Identity</h2>
            <Input
              label="App name"
              value={draft.appName ?? ""}
              maxLength={TEXT_LIMITS.appName}
              readOnly={locked}
              placeholder={inheritedText("appName")}
              error={errors.appName}
              onChange={(e) => patch({ appName: e.target.value })}
            />
            {IMAGE_FIELDS.filter((f) => f.slot !== "background").map((f) => (
              <ImageField
                key={f.slot}
                slot={f.slot}
                label={f.label}
                value={draft[f.slot]}
                readOnly={locked}
                onChange={(v) => patch({ [f.slot]: v })}
              />
            ))}
          </section>
          <section>
            <h2>Wording</h2>
            {TEXT_FIELDS.filter((f) => f.slot !== "appName").map((f) => (
              <Input
                key={f.slot}
                label={f.label}
                value={draft[f.slot] ?? ""}
                maxLength={TEXT_LIMITS[f.slot]}
                readOnly={locked}
                placeholder={inheritedText(f.slot)}
                error={errors[f.slot]}
                onChange={(e) => patch({ [f.slot]: e.target.value })}
              />
            ))}
          </section>
          <section>
            <h2>Layout and background</h2>
            <Select
              label="Layout"
              placeholder="Inherit"
              disabled={locked}
              value={draft.layout ?? undefined}
              options={[
                { value: "centered", label: "Centered" },
                { value: "split", label: "Split" },
              ]}
              onChange={(v) => patch({ layout: v ?? null })}
            />
            {IMAGE_FIELDS.filter((f) => f.slot === "background").map((f) => (
              <ImageField
                key={f.slot}
                slot={f.slot}
                label={f.label}
                value={draft[f.slot]}
                readOnly={locked}
                onChange={(v) => patch({ [f.slot]: v })}
              />
            ))}
          </section>
          <section>
            <h2>Footer links</h2>
            <FooterLinksField
              value={draft.footerLinks}
              onChange={(v) => patch({ footerLinks: v })}
              errors={errors}
              readOnly={locked}
            />
          </section>
          <section>
            <h2>Colours</h2>
            <div className="t-branding-modes">
              {(["light", "dark"] as const).map((m) => (
                <Button
                  key={m}
                  variant={mode === m ? "primary" : "secondary"}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                >
                  {m === "light" ? "Light" : "Dark"}
                </Button>
              ))}
            </div>
            {mode === "light" ? mk("colorsLight") : mk("colorsDark")}
          </section>
          {appliesToConsole && (
            <section>
              <h2>Console</h2>
              <Checkbox
                label="Also brand the admin console"
                checked={draft.applyToConsole}
                disabled={locked}
                onChange={(e) => patch({ applyToConsole: e.target.checked })}
              />
              {consoleHasOwnProfile && (
                <p className="t-branding-hint">
                  The admin console ({CORE_LOGIN_CLIENT_ID}) has its own
                  branding profile, so this setting has no effect: the console
                  follows that profile&apos;s setting.
                </p>
              )}
            </section>
          )}
        </div>
        <div className="t-branding-side">
          <BrandingPreview draft={draft} inherited={profile.inherited} />
          {profile.canManageGrants && profile.client && (
            <GrantsPanel clientId={profile.client.id} />
          )}
        </div>
      </div>
      <ProvisionedDialog
        show={showProvisioned}
        provisionedFrom={profile.provisionedFrom}
        onClose={() => setShowProvisioned(false)}
      />
      <ConfirmationModal
        show={showDelete}
        handleHide={() => setShowDelete(false)}
        title="Remove branding"
        body="This removes the profile; sign-in pages fall back to the inherited branding."
        confirmButtonText="Remove"
        isLoading={remove.isPending}
        handleConfirm={async () => {
          try {
            await remove.mutateAsync();
          } catch {
            return;
          }
          // The refetch remounts the form, so navigate from here, not from a mutate callback.
          setShowDelete(false);
          navigate("/auth-admin/branding");
        }}
      />
      <ConfirmationModal
        show={blocker.state === "blocked"}
        handleHide={() => blocker.reset?.()}
        title="Discard unsaved changes?"
        body="You have unsaved branding changes. Leaving now discards them."
        confirmButtonText="Discard and leave"
        cancelButtonText="Keep editing"
        handleConfirm={() => blocker.proceed?.()}
      />
    </Page>
  );
};

export const BrandingEditor = ({ target }: { target: BrandingTarget }) => {
  useStockColors();
  const { data, isLoading } = useBrandingProfile(target);
  useDocumentTitle(
    target.kind === "default" ? "Default branding" : data?.client?.name
  );

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Branding not found</EmptyState>
      </Page>
    );
  }
  // A saved or reloaded profile starts a fresh draft.
  return (
    <EditorForm
      key={data.updatedAt ?? "unsaved"}
      target={target}
      profile={data}
    />
  );
};
