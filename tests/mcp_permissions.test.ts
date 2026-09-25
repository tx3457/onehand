import { describe, expect, it } from "vitest";
import { PermissionEngine, classifyToolRisk, type AuthorizationRequest } from "../src/policy/permissions.js";

const request = (name = "mcp__git-server__show-file"): AuthorizationRequest => ({
  name, args: {}, risk: classifyToolRisk(name, {})
});

describe("MCP permissions", () => {
  it("classifies MCP tools separately and sub-agent tools as reads", () => {
    expect(classifyToolRisk("mcp__server__tool", {})).toBe("mcp");
    expect(classifyToolRisk("explore", {})).toBe("read");
    expect(classifyToolRisk("review_changes", {})).toBe("read");
  });

  it("uses conservative MCP defaults in every mode", () => {
    expect(new PermissionEngine({ mode: "ask" }).resolve(request())).toEqual({ decision: "deny", source: "mode" });
    expect(new PermissionEngine({ mode: "edit" }).resolve(request())).toEqual({ decision: "ask", source: "mode" });
    expect(new PermissionEngine({ mode: "auto" }).resolve(request())).toEqual({ decision: "deny", source: "mode" });
  });

  it("supports exact and server-wide MCP allow rules with deny precedence", () => {
    const exact = new PermissionEngine({ mode: "ask", projectRules: { allow: ["mcp__git-server__show-file"] } });
    expect(exact.resolve(request())).toEqual({ decision: "allow", source: "project" });
    expect(exact.resolve(request("mcp__git-server__other"))).toEqual({ decision: "deny", source: "mode" });

    const wildcard = new PermissionEngine({
      mode: "auto",
      cliRules: { allow: ["mcp__git-server__*"] },
      userRules: { deny: ["mcp__git-server__delete-file"] }
    });
    expect(wildcard.resolve(request("mcp__git-server__show-file"))).toEqual({ decision: "allow", source: "cli" });
    expect(wildcard.resolve(request("mcp__git-server__delete-file"))).toEqual({ decision: "deny", source: "user" });
    expect(wildcard.resolve(request("mcp__git-server-extra__show-file"))).toEqual({ decision: "deny", source: "mode" });
  });
});
