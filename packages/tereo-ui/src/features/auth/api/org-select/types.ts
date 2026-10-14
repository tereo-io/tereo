export interface OrgSelectOrganization {
  id: string;
  name: string;
  slug: string;
}

export interface OrgSelectSession {
  organizations: OrgSelectOrganization[];
  client: { name: string };
  user: { email: string; name: string | null };
}

export interface OrgSelectSubmitParams {
  session_token: string;
  organization_id: string;
}

export interface OrgSelectSubmitResponse {
  redirect_url: string;
}
