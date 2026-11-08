import useDeleteBrandingProfile from "../../api/branding/useDeleteBrandingProfile";
import { TEXT_LIMITS, validateDraft } from "../../api/branding/brandingErrors";
import useSaveBrandingProfile from "../../api/branding/useSaveBrandingProfile";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AxiosError } from "axios";
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

/** Deep equality that ignores object key order, as a cleared and retyped colour reorders keys. */
export const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.hasOwn(b, k) &&
        sameValue(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k]
        )
    )
  );
};

/** The full PUT body: core replaces the whole profile. */
const toBody = (draft: BrandingDraft): AdminProfileBody => ({
  appName: blankToNull(draft.appName),
  headline: blankToNull(draft.headline),
  subtitle: blankToNull(draft.subtitle),
  signInLabel: blankToNull(draft.signInLabel),
  notice: blankToNull(draft.notice),
  layout: draft.layout,
  // null inherits the default's links; [] shows none.
  footerLinks:
    draft.footerLinks?.map((l) => ({
      label: l.label.trim(),
      url: l.url.trim(),
    })) ?? null,
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
  /** The profile changed on the server since this form loaded it. */
  stale: boolean;
  onReload: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}

const EditorForm = ({
  target,
  profile,
  stale,
  onReload,
  onDirtyChange,
  onSaved,
}: FormProps) => {
  const navigate = useNavigate();
  const initial = useMemo<BrandingDraft>(
    () => profile.own ?? emptyDraft(),
    [profile]
  );
  const [draft, setDraft] = useState<BrandingDraft>(initial);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [showProvisioned, setShowProvisioned] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [uploads, setUploads] = useState(0);
  const save = useSaveBrandingProfile(target);
  const remove = useDeleteBrandingProfile(target);

  const locked = profile.provisioned || !profile.canEdit;
  const dirty = !sameValue(draft, initial);
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const hasErrors = Object.keys(errors).length > 0;

  // An upload in flight counts as unsaved: a remount would drop its result.
  const busy = dirty || uploads > 0;
  useEffect(() => onDirtyChange(busy), [busy, onDirtyChange]);
  const trackUpload = useCallback(
    (pending: boolean) =>
      setUploads((n) => Math.max(0, n + (pending ? 1 : -1))),
    []
  );

  // Set once the profile is removed: there is nothing left to keep.
  const removed = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      !removed.current &&
      currentLocation.pathname !== nextLocation.pathname
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
          onClick={() => save.mutate(toBody(draft), { onSuccess: onSaved })}
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
      {stale && !save.isPending && (
        <div className="t-branding-banner">
          <Alert variant="warning">
            This branding was changed elsewhere since you opened it. Saving
            replaces those changes.{" "}
            <Button size="sm" variant="secondary" onClick={onReload}>
              Reload and discard my edits
            </Button>
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
                onPendingChange={trackUpload}
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
                onPendingChange={trackUpload}
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
          {profile.client &&
            (profile.canManageGrants || profile.canViewGrants) && (
              <GrantsPanel
                clientId={profile.client.id}
                readOnly={!profile.canManageGrants}
              />
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
          removed.current = true;
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

const statusOf = (error: unknown) =>
  error instanceof AxiosError ? error.response?.status : undefined;

export const BrandingEditor = ({ target }: { target: BrandingTarget }) => {
  useStockColors();
  const { data, isLoading, isError, error, refetch, isRefetching } =
    useBrandingProfile(target);
  useDocumentTitle(
    target.kind === "default" ? "Default branding" : data?.client?.name
  );

  // The form edits the profile as it was loaded. A refetch (window focus,
  // another tab's save) replaces it only while there is nothing to lose;
  // with unsaved edits the form stays and offers a reload instead.
  const [shown, setShown] = useState<BrandingProfile | undefined>(data);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const show = (next: BrandingProfile | undefined) => {
    setShown(next);
    setGeneration((g) => g + 1);
    setDirty(false);
  };
  if (data !== shown && (!shown || !dirty)) show(data);

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }
  if (!shown) {
    const notFound = !isError || statusOf(error) === 404;
    const forbidden = isError && statusOf(error) === 403;
    return (
      <Page padded fillHeight>
        <EmptyState
          layout="block"
          action={
            notFound || forbidden ? undefined : (
              <Button isLoading={isRefetching} onClick={() => refetch()}>
                Retry
              </Button>
            )
          }
        >
          {notFound
            ? "Branding not found"
            : forbidden
              ? "You don't have access to this client's branding"
              : "Could not load this branding"}
        </EmptyState>
      </Page>
    );
  }
  return (
    <EditorForm
      key={generation}
      target={target}
      profile={shown}
      stale={!!data && data !== shown}
      onReload={() => show(data)}
      onDirtyChange={setDirty}
      // A save replaces the profile with what was just stored.
      onSaved={() => setDirty(false)}
    />
  );
};
