// identity.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateIdentity, signData, verifyData, peerIdFor } from "../src/identity";

const freshDir = () => mkdtempSync(join(tmpdir(), "mesh-id-"));

describe("identity", () => {
  test("generates a stable identity and persists it", () => {
    const dir = freshDir();
    const a = loadOrCreateIdentity(dir);
    const b = loadOrCreateIdentity(dir);
    expect(a.id).toBe(b.id);
    expect(a.id).toHaveLength(32);
    expect(a.id).toBe(peerIdFor(a.publicKey));
    expect(a.publicKey).toBe(b.publicKey);
  });

  test("sign / verify round-trip", () => {
    const idn = loadOrCreateIdentity(freshDir());
    const sig = signData(idn, "hello mesh");
    expect(verifyData(idn.publicKey, "hello mesh", sig)).toBe(true);
  });

  test("tampered message fails verification", () => {
    const idn = loadOrCreateIdentity(freshDir());
    const sig = signData(idn, "hello mesh");
    expect(verifyData(idn.publicKey, "hello mesh!", sig)).toBe(false);
  });

  test("wrong public key fails verification", () => {
    const a = loadOrCreateIdentity(freshDir());
    const b = loadOrCreateIdentity(freshDir());
    const sig = signData(a, "data");
    expect(verifyData(b.publicKey, "data", sig)).toBe(false);
  });

  test("garbage inputs fail closed", () => {
    expect(verifyData("not-base64!!", "x", "y")).toBe(false);
    expect(verifyData("", "", "")).toBe(false);
  });
});
