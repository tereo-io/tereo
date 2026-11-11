export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const LIST_RESPONSE_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SERVICE_PROVIDER_CONFIG_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const RESOURCE_TYPE_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

export const MAX_FILTER_RESULTS = 200;

interface AttributeDefinition {
  name: string;
  type: "string" | "boolean" | "complex";
  multiValued: boolean;
  description: string;
  required: boolean;
  mutability: "readWrite";
  returned: "default";
  uniqueness: "none" | "server";
  caseExact?: boolean;
  subAttributes?: AttributeDefinition[];
}

export interface ResourceDefinition {
  id: string;
  name: string;
  endpoint: string;
  description: string;
  schema: string;
  attributes: AttributeDefinition[];
}

const attr = (
  name: string,
  type: AttributeDefinition["type"],
  description: string,
  extra: Partial<AttributeDefinition> = {}
): AttributeDefinition => ({
  name,
  type,
  multiValued: false,
  description,
  required: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...(type === "string" && { caseExact: false }),
  ...extra,
});

const USER: ResourceDefinition = {
  id: "User",
  name: "User",
  endpoint: "/Users",
  description: "A person who signs in through the identity provider",
  schema: USER_SCHEMA,
  attributes: [
    attr("userName", "string", "Unique identifier for the user", {
      required: true,
      uniqueness: "server",
    }),
    attr("externalId", "string", "Identifier the provisioning client uses", {
      caseExact: true,
    }),
    attr("name", "complex", "The components of the user's name", {
      subAttributes: [
        attr("givenName", "string", "Given name"),
        attr("familyName", "string", "Family name"),
        attr(
          "formatted",
          "string",
          "Full name, used when displayName is absent"
        ),
      ],
    }),
    attr("displayName", "string", "Name shown for the user"),
    attr("emails", "complex", "Email addresses; the primary one is used", {
      multiValued: true,
      subAttributes: [
        attr("value", "string", "The address"),
        attr("type", "string", "Label, such as work"),
        attr("primary", "boolean", "Whether this is the primary address"),
      ],
    }),
    attr("active", "boolean", "Whether the user can sign in"),
  ],
};

export const RESOURCES: readonly ResourceDefinition[] = [USER];

const list = (resources: unknown[]) => ({
  schemas: [LIST_RESPONSE_SCHEMA],
  totalResults: resources.length,
  startIndex: 1,
  itemsPerPage: resources.length,
  Resources: resources,
});

export const serviceProviderConfig = (baseUrl: string) => ({
  schemas: [SERVICE_PROVIDER_CONFIG_SCHEMA],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAX_FILTER_RESULTS },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description: "Authentication with the connection's bearer token",
      specUri: "https://www.rfc-editor.org/info/rfc6750",
      primary: true,
    },
  ],
  meta: {
    resourceType: "ServiceProviderConfig",
    location: `${baseUrl}/ServiceProviderConfig`,
  },
});

export const resourceTypes = (baseUrl: string) =>
  list(
    RESOURCES.map((r) => ({
      schemas: [RESOURCE_TYPE_SCHEMA],
      id: r.id,
      name: r.name,
      endpoint: r.endpoint,
      description: r.description,
      schema: r.schema,
      meta: {
        resourceType: "ResourceType",
        location: `${baseUrl}/ResourceTypes/${r.id}`,
      },
    }))
  );

export const schemas = (): Record<string, unknown> =>
  list(
    RESOURCES.map((r) => ({
      schemas: [SCHEMA_SCHEMA],
      id: r.schema,
      name: r.name,
      description: r.description,
      attributes: r.attributes,
    }))
  );
