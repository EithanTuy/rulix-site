// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  OrganizationAuthorizationError,
  capabilitiesForOrganizationRole,
  hasOrganizationCapability,
  requireOrganizationCapability
} from "./authorization";

describe("organization capability matrix", () => {
  it("gives export-control officers organization and decision authority", () => {
    expect(hasOrganizationCapability("export-control-officer", "organization:manage")).toBe(true);
    expect(hasOrganizationCapability("export-control-officer", "member:manage")).toBe(true);
    expect(hasOrganizationCapability("export-control-officer", "decision:override")).toBe(true);
  });

  it("allows reviewers to analyze and accept without granting organization administration", () => {
    expect(hasOrganizationCapability("reviewer", "analysis:run")).toBe(true);
    expect(hasOrganizationCapability("reviewer", "decision:accept")).toBe(true);
    expect(hasOrganizationCapability("reviewer", "organization:manage")).toBe(false);
    expect(hasOrganizationCapability("reviewer", "decision:override")).toBe(false);
  });

  it("limits submitters to creating and editing their own reviews", () => {
    expect(capabilitiesForOrganizationRole("submitter")).toContain("review:edit-own");
    expect(hasOrganizationCapability("submitter", "review:edit-any")).toBe(false);
    expect(hasOrganizationCapability("submitter", "analysis:run")).toBe(false);
    expect(hasOrganizationCapability("submitter", "decision:accept")).toBe(false);
  });

  it("fails closed for unknown roles and exposes a consistent authorization error", () => {
    expect(capabilitiesForOrganizationRole("unknown-role")).toEqual([]);
    expect(() => requireOrganizationCapability("counsel", "decision:accept")).toThrow(
      OrganizationAuthorizationError
    );
    try {
      requireOrganizationCapability("counsel", "decision:accept");
    } catch (error) {
      expect(error).toMatchObject({ code: "organization_forbidden", status: 403 });
    }
  });
});
