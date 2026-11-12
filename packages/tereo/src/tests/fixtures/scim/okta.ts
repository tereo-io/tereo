const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export const oktaCreateUser = {
  schemas: [USER],
  userName: "jane.doe@example.com",
  name: { givenName: "Jane", familyName: "Doe" },
  emails: [{ primary: true, value: "jane.doe@example.com", type: "work" }],
  displayName: "Jane Doe",
  externalId: "00u1abcd2EFGH3ijk4l5",
  active: true,
};

export const oktaReplaceUser = {
  schemas: [USER],
  id: "0198f2a4-0000-7000-8000-000000000001",
  userName: "jane.doe@example.com",
  name: { givenName: "Jane", familyName: "Smith" },
  emails: [{ primary: true, value: "jane.doe@example.com", type: "work" }],
  displayName: "Jane Smith",
  externalId: "00u1abcd2EFGH3ijk4l5",
  active: true,
};

export const oktaDeactivatePatch = {
  schemas: [PATCH_OP],
  Operations: [{ op: "replace", value: { active: false } }],
};

export const oktaAttributePatch = {
  schemas: [PATCH_OP],
  Operations: [
    {
      op: "replace",
      value: { displayName: "Jane Q. Doe", "name.givenName": "Janet" },
    },
  ],
};
