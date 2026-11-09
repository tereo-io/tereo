import { errorCodeOf, errorDescriptionOf } from "@/utils/apiErrors";

const NOT_PERMITTED =
  "You can manage guests only in an organization you belong to.";

export const inviteGuestErrorMessage = (error: unknown): string => {
  switch (errorCodeOf(error)) {
    case "user_exists":
      return "This person already has an account. Add them to the organization as a member instead.";
    case "email_unavailable":
      return "This email can't be invited. Ask an administrator.";
    case "guest_in_other_organization":
      return "This person is a guest of another organization.";
    case "guest_unassigned":
      return "This guest belongs to no organization. Only an administrator who manages organizations can invite them again.";
    case "organization_not_permitted":
      return "You can invite guests only into an organization you belong to.";
    case "user_not_invitable":
      return "This account cannot be invited as a guest.";
    case "sso_only_domain":
      return "This email's domain signs in only through its identity provider, so a setup link would not work. Give the guest a password instead.";
    case "email_not_configured":
      return "Core has no email connection, so it cannot email the link. Turn off emailing to get the link here instead.";
    default:
      return errorDescriptionOf(error, "Failed to invite guest");
  }
};

export const extendGuestErrorMessage = (error: unknown): string => {
  switch (errorCodeOf(error)) {
    case "organization_not_permitted":
      return NOT_PERMITTED;
    case "not_a_guest":
      return "This user is no longer a guest.";
    default:
      return errorDescriptionOf(error, "Failed to update guest");
  }
};

export const passwordLinkErrorMessage = (error: unknown): string => {
  switch (errorCodeOf(error)) {
    case "guest_has_password":
      return "This guest has already set a password. Only an administrator who can manage users can send them a new link.";
    case "guest_not_usable":
      return "This guest is deactivated or expired. Extend their access first.";
    case "sso_only_domain":
      return "This guest's email domain signs in only through its identity provider, so a setup link would not work.";
    case "email_not_configured":
      return "Core has no email connection, so it cannot email the link. Turn off emailing to get the link here instead.";
    case "organization_not_permitted":
      return NOT_PERMITTED;
    default:
      return errorDescriptionOf(error, "Failed to create the password link");
  }
};

export const promoteGuestErrorMessage = (error: unknown): string => {
  switch (errorCodeOf(error)) {
    case "password_not_user_set":
      return "This guest has not chosen their own password yet. Promote them once they have.";
    default:
      return errorDescriptionOf(error, "Failed to promote guest");
  }
};
