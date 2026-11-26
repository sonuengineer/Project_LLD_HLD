// Stage 6: sessions auto-lock after a period of inactivity. Lazy expiry, not a background timer -- the same
// idiom this project already uses for the lockout cooldown and SESSION_INVALIDATED: checked on next use,
// never on a schedule. requireSession() is the one choke point every session-based call goes through, so it
// is the only place that checks AND resets the idle clock.
import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "../src/manager.js";
import { asyncErrorCode, errorCode, setup } from "./helpers.js";

describe("session idle timeout", () => {
  it("a session idle for longer than the timeout throws SESSION_IDLE_TIMEOUT on next use", () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");

    clock.advance(1_001);
    expect(errorCode(() => manager.listEntries(sessionId))).toBe("SESSION_IDLE_TIMEOUT");
  });

  it("a session used right up to (but not past) the timeout stays active", () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");

    clock.advance(1_000); // exactly at the boundary -- still allowed
    expect(manager.listEntries(sessionId)).toEqual([]);
  });

  it("using a session resets its idle clock -- periodic activity keeps it alive indefinitely", async () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");

    // 10 cycles of "almost timed out, but touched just in time" sum to far more than one timeout's worth of
    // elapsed time -- this only works if each touch genuinely resets the clock.
    for (let i = 0; i < 10; i++) {
      clock.advance(900);
      manager.listEntries(sessionId); // activity
    }
    expect(manager.isSessionActive(sessionId)).toBe(true);
  });

  it("isSessionActive reports the timeout without needing a throwing call first", () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");

    expect(manager.isSessionActive(sessionId)).toBe(true);
    clock.advance(1_001);
    expect(manager.isSessionActive(sessionId)).toBe(false);
  });

  it("isSessionActive is a pure read: calling it repeatedly does NOT itself reset the idle clock", () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");

    for (let i = 0; i < 5; i++) {
      clock.advance(300);
      manager.isSessionActive(sessionId); // polling, not activity
    }
    // 5 x 300ms = 1500ms total elapsed, past the 1000ms timeout -- the polling must not have kept it alive.
    expect(manager.isSessionActive(sessionId)).toBe(false);
    expect(errorCode(() => manager.listEntries(sessionId))).toBe("SESSION_IDLE_TIMEOUT");
  });

  it("multiple sessions on the same vault have INDEPENDENT idle clocks", () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const phone = manager.unlock("alice", "correct-horse-battery");
    const laptop = manager.unlock("alice", "correct-horse-battery");

    clock.advance(600);
    manager.listEntries(laptop.sessionId); // laptop stays active; phone does not get this activity
    clock.advance(500); // total elapsed since unlock: phone 1100ms, laptop 500ms since its own last use

    expect(manager.isSessionActive(phone.sessionId)).toBe(false);
    expect(manager.isSessionActive(laptop.sessionId)).toBe(true);
  });

  it("a freshly unlocked session starts its idle clock at the moment of unlock, not some earlier time", () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    clock.advance(10_000); // a lot of time passes before alice ever unlocks
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");
    expect(manager.isSessionActive(sessionId)).toBe(true); // not instantly idle-expired
  });

  it(`defaults to ${DEFAULT_SESSION_IDLE_TIMEOUT_MS}ms when none is given`, () => {
    const { manager, clock } = setup(); // no sessionIdleTimeoutMs override
    manager.createVault("alice", "correct-horse-battery");
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");

    clock.advance(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(manager.isSessionActive(sessionId)).toBe(true); // still within the default

    clock.advance(1);
    expect(manager.isSessionActive(sessionId)).toBe(false);
  });

  it("an idle-timed-out session is cleaned up: isSessionActive reflects it immediately, and it never becomes valid again", async () => {
    const { manager, clock } = setup({ sessionIdleTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const { sessionId } = manager.unlock("alice", "correct-horse-battery");

    clock.advance(1_001);
    expect(await asyncErrorCode(() => manager.addEntry(sessionId, { title: "t", username: "a", password: "p" }))).toBe(
      "SESSION_IDLE_TIMEOUT",
    );
    // lazily cleaned up on that failed attempt -- a second touch reports UNKNOWN_SESSION, not another timeout
    expect(errorCode(() => manager.listEntries(sessionId))).toBe("UNKNOWN_SESSION");
  });
});
