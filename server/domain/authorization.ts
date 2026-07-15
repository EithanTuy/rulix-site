import type { UserProfile } from "../../src/types";

export type OrganizationRole = UserProfile["role"];

export const ORGANIZATION_CAPABILITIES = Object.freeze([
  "organization:manage",
  "member:manage",
  "review:read",
  "review:create",
  "review:edit-own",
  "review:edit-any",
  "review:archive",
  "review:assign",
  "review:comment",
  "analysis:run",
  "decision:request-info",
  "decision:accept",
  "decision:override",
  "audit:read",
  "corpus:manage"
] as const);

export type OrganizationCapability = (typeof ORGANIZATION_CAPABILITIES)[number];

const officerCapabilities = [...ORGANIZATION_CAPABILITIES];

function frozenCapabilities(
  ...capabilities: OrganizationCapability[]
): readonly OrganizationCapability[] {
  return Object.freeze(capabilities);
}

export const ROLE_CAPABILITY_MATRIX: Readonly<
  Record<OrganizationRole, readonly OrganizationCapability[]>
> = Object.freeze({
  "export-control-officer": frozenCapabilities(...officerCapabilities),
  reviewer: frozenCapabilities(
    "review:read",
    "review:create",
    "review:edit-own",
    "review:edit-any",
    "review:archive",
    "review:comment",
    "analysis:run",
    "decision:request-info",
    "decision:accept",
    "audit:read"
  ),
  submitter: frozenCapabilities(
    "review:read",
    "review:create",
    "review:edit-own",
    "review:comment"
  ),
  counsel: frozenCapabilities(
    "review:read",
    "review:create",
    "review:edit-own",
    "review:comment",
    "analysis:run",
    "decision:request-info",
    "audit:read"
  )
});

export class OrganizationAuthorizationError extends Error {
  readonly code = "organization_forbidden";
  readonly status = 403;

  constructor(readonly capability: OrganizationCapability) {
    super(`Organization capability required: ${capability}.`);
    this.name = "OrganizationAuthorizationError";
  }
}

export function capabilitiesForOrganizationRole(
  role: OrganizationRole | string | undefined
): readonly OrganizationCapability[] {
  if (!role || !(role in ROLE_CAPABILITY_MATRIX)) return [];
  return ROLE_CAPABILITY_MATRIX[role as OrganizationRole];
}

export function hasOrganizationCapability(
  role: OrganizationRole | string | undefined,
  capability: OrganizationCapability
): boolean {
  return capabilitiesForOrganizationRole(role).includes(capability);
}

export function requireOrganizationCapability(
  role: OrganizationRole | string | undefined,
  capability: OrganizationCapability
): void {
  if (!hasOrganizationCapability(role, capability)) {
    throw new OrganizationAuthorizationError(capability);
  }
}
