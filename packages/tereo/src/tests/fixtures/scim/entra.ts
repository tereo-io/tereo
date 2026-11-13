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

const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";

// The Group shapes below are our best understanding of Entra's provisioning
// requests, not copied from a captured request. To be confirmed in the manual
// tenant run.
export const entraCreateGroup = {
  schemas: [GROUP],
  externalId: "9c2d4f6b-3e5a-4b7c-8d9e-1f2a3b4c5d6e",
  displayName: "Platform Engineering",
  members: [
    { value: "0198f2a4-0000-7000-8000-000000000001" },
    { value: "0198f2a4-0000-7000-8000-000000000002" },
  ],
};

export const entraAddMembersPatch = {
  schemas: [PATCH_OP],
  Operations: [
    {
      op: "Add",
      path: "members",
      value: [{ value: "0198f2a4-0000-7000-8000-000000000003" }],
    },
  ],
};

export const entraRemoveMembersPatch = {
  schemas: [PATCH_OP],
  Operations: [
    {
      op: "Remove",
      path: "members",
      value: [
        { value: "0198f2a4-0000-7000-8000-000000000001" },
        { value: "0198f2a4-0000-7000-8000-000000000002" },
      ],
    },
  ],
};

export const entraRenameGroupPatch = {
  schemas: [PATCH_OP],
  Operations: [{ op: "Replace", path: "displayName", value: "Platform Eng" }],
};
