export interface SetupStatus {
  setupComplete: boolean;
}

/** `POST /setup`, authorized by the setup token core prints to its log. */
export interface CompleteSetupInput {
  token: string;
  admin: { email: string; name: string; password: string };
  organization: { name: string; slug: string; code: string };
}

export interface CompleteSetupResult {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; name: string; slug: string; code: string };
}
