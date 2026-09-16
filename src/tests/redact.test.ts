import { describe, expect, it } from "vitest";
import { redactString, sanitizeErrorMessage, sanitizeSandboxError } from "../server/utils/redact.js";

describe("redactString — raw API tokens", () => {
  it("redacts personal/deploy/runner/OAuth tokens without scheme keyword", () => {
    expect(redactString("token glpat-abcDEF1234567890 leaked")).toBe(
      "token [REDACTED] leaked"
    );
    expect(redactString("key=gldt-xyz_123-456.7890")).toBe("key=[REDACTED]");
    expect(redactString("auth glrt-0123456789abcdef")).toBe("auth [REDACTED]");
  });

  it("does not redact short lookalikes", () => {
    expect(redactString("glpat-abc")).toBe("glpat-abc");
  });
});

describe("redactString — URL credentials stay authority-scoped", () => {
  it("redacts credentials in the URL authority portion", () => {
    expect(redactString("fetch https://user:s3cret@host/source/ failed")).toBe(
      "fetch https://***:***@host/source/ failed"
    );
  });

  it("leaves OpenGrok @revision paths alone", () => {
    const url = "https://host/source/history/proj/path/file.java@abc123";
    expect(redactString(url)).toBe(url);
  });
});

describe("token redaction flows through sanitizers", () => {
  it("sanitizeErrorMessage redacts raw tokens", () => {
    expect(sanitizeErrorMessage("store failed for glpat-abcDEF1234567890")).toBe(
      "store failed for [REDACTED]"
    );
  });

  it("sanitizeSandboxError redacts raw tokens", () => {
    expect(sanitizeSandboxError("bad glpat-abcDEF1234567890 value")).toContain(
      "[REDACTED]"
    );
  });
});
