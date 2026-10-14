export interface StandardClaims {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  updated_at?: number;
  email?: string;
  email_verified?: boolean;
}

export interface UserData {
  id: string;
  email: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  updatedAt: Date;
}

export const buildUserClaims = (
  user: UserData,
  scopes: string[]
): StandardClaims => {
  const claims: StandardClaims = {
    sub: user.id,
  };

  if (scopes.includes("profile")) {
    if (user.name) claims.name = user.name;
    if (user.firstName) claims.given_name = user.firstName;
    if (user.lastName) claims.family_name = user.lastName;
    if (user.photoUrl) claims.picture = user.photoUrl;
    claims.updated_at = Math.floor(user.updatedAt.getTime() / 1000);
  }

  if (scopes.includes("email")) {
    claims.email = user.email;
    claims.email_verified = true;
  }

  return claims;
};
