import { describe, expect, it } from "vitest";
import { InMemoryUsers } from "../src/index.js";
import { errorCode } from "./helpers.js";

describe("InMemoryUsers", () => {
  it("rejects an empty or whitespace-only userId or displayName", () => {
    const users = new InMemoryUsers();
    expect(errorCode(() => users.upsert({ userId: "", displayName: "Asha" }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => users.upsert({ userId: "  ", displayName: "Asha" }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => users.upsert({ userId: "u1", displayName: "" }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => users.upsert({ userId: "u1", displayName: "  " }))).toBe("INVALID_REQUEST");
  });

  it("get() of an unknown user is undefined", () => {
    const users = new InMemoryUsers();
    expect(users.get("ghost")).toBeUndefined();
  });

  it("upsert stores a COPY: mutating the caller's object afterward does not change the stored user", () => {
    const users = new InMemoryUsers();
    const given = { userId: "u1", displayName: "Asha" };
    users.upsert(given);
    given.displayName = "tampered";
    expect(users.get("u1")!.displayName).toBe("Asha");
  });

  it("get() returns a copy: mutating the result does not change the stored user", () => {
    const users = new InMemoryUsers();
    users.upsert({ userId: "u1", displayName: "Asha" });
    const fetched = users.get("u1")!;
    fetched.displayName = "tampered";
    expect(users.get("u1")!.displayName).toBe("Asha");
  });

  it("upsert again for the same userId replaces the user", () => {
    const users = new InMemoryUsers();
    users.upsert({ userId: "u1", displayName: "Asha" });
    users.upsert({ userId: "u1", displayName: "Asha K." });
    expect(users.get("u1")!.displayName).toBe("Asha K.");
  });
});
