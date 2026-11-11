const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export const entraCreateUser = {
  schemas: [USER],
  externalId: "7b1c3e5a-2d4f-4a6b-8c9d-0e1f2a3b4c5d",
  userName: "jane.doe@example.com",
  active: true,
  displayName: "Jane Doe",
  name: { givenName: "Jane", familyName: "Doe" },
  emails: [{ primary: true, type: "work", value: "jane.doe@example.com" }],
};

export const entraUpnCreateUser = {
  ...entraCreateUser,
  userName: "jdoe",
  emails: [{ primary: true, type: "work", value: "jane.doe@example.com" }],
};

export const entraReplaceUser = {
  ...entraCreateUser,
  displayName: "Jane Smith",
  name: { givenName: "Jane", familyName: "Smith" },
};

export const entraDeactivatePatch = {
  schemas: [PATCH_OP],
  Operations: [{ op: "Replace", path: "active", value: "False" }],
};

export const entraAttributePatch = {
  schemas: [PATCH_OP],
  Operations: [
    { op: "Replace", path: "name.givenName", value: "Janet" },
    { op: "Replace", path: "name.familyName", value: "Roe" },
    {
      op: "Replace",
      path: 'emails[type eq "work"].value',
      value: "Janet.Roe@Example.com",
    },
    { op: "Add", path: "externalId", value: "new-external-id" },
  ],
};
