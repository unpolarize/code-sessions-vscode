import { describe, expect, it } from "vitest";
import {
  formatSessionMarkdown,
  formatSessionUri,
  isSessionId,
  parseSessionUri,
  SESSION_LINK_AUTHORITY,
} from "../../src/sessionLink";

const ID = "4ba90b1a-6188-4702-9476-402fcb37c3af";

describe("sessionLink", () => {
  it("accepts UUID session ids and rejects traversal", () => {
    expect(isSessionId(ID)).toBe(true);
    expect(isSessionId("01a00f12-4700-7133-98fd-ef849de89fed")).toBe(true);
    expect(isSessionId("../etc/passwd")).toBe(false);
    expect(isSessionId("hosts/foo/bar")).toBe(false);
    expect(isSessionId("")).toBe(false);
  });

  it("formats the single-authority vscode URI (default view=csv omitted)", () => {
    expect(formatSessionUri({ session: ID })).toBe(
      `vscode://${SESSION_LINK_AUTHORITY}/open?session=${ID}`,
    );
    expect(formatSessionUri({ session: ID, view: "cb", host: "air" })).toBe(
      `vscode://${SESSION_LINK_AUTHORITY}/open?session=${ID}&view=cb&host=air`,
    );
  });

  it("formats a markdown link for notes / READMEs", () => {
    expect(formatSessionMarkdown("Shareable Session Links", { session: ID })).toBe(
      `[Shareable Session Links](vscode://${SESSION_LINK_AUTHORITY}/open?session=${ID})`,
    );
  });

  it("parses vscode:// URIs including query-only handler payloads", () => {
    const full = parseSessionUri(
      `vscode://${SESSION_LINK_AUTHORITY}/open?session=${ID}&view=cb`,
    );
    expect(full).toEqual({ session: ID, view: "cb" });

    const fromHandler = parseSessionUri({
      authority: SESSION_LINK_AUTHORITY,
      path: "/open",
      query: `session=${ID}`,
    });
    expect(fromHandler).toEqual({ session: ID, view: "csv" });
  });

  it("rejects other authorities and non-uuid sessions", () => {
    expect(parseSessionUri(`vscode://evil.ext/open?session=${ID}`)).toBeNull();
    expect(
      parseSessionUri(`vscode://${SESSION_LINK_AUTHORITY}/open?session=../x`),
    ).toBeNull();
  });
});
