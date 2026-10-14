// Public API barrel for the auth feature.
// Cross-feature consumers must import only from this file.

export { default as LoginButton } from "./components/login/LoginButton";
export { OrgSwitcher } from "./components/org-select/OrgSwitcher";
export { RequireAuth } from "./components/RequireAuth";
export { default as useUpstreamProviders } from "./api/upstream/useUpstreamProviders";
export { upstreamErrorMessage } from "./api/upstream/upstreamErrors";
export { isReauthRequired, restartLoginFresh } from "./api/upstream/reauth";
export { upstreamStartUrl } from "./api/upstream/upstreamUrls";
export { redirectTo } from "./api/redirectTo";
