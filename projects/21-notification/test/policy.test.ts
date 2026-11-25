import { describe, expect, it } from "vitest";
import { planChannel } from "../src/policy.js";
import { PreferenceStore, quietUntil } from "../src/preferences.js";
import { InMemoryUsers } from "../src/users.js";
import { errorCode, FULL_USER, HOUR, MIN } from "./helpers.js";

const DAY0 = Date.UTC(2026, 10, 23); // midnight UTC
const at = (h: number, m = 0) => DAY0 + h * HOUR + m * MIN;
const NIGHT = { start: "22:00", end: "07:00" };

describe("quietUntil", () => {
  it("window crossing midnight: start inclusive, end exclusive", () => {
    expect(quietUntil(at(21, 59), 0, NIGHT)).toBeUndefined();
    expect(quietUntil(at(22, 0), 0, NIGHT)).toBe(at(31)); // next day 07:00
    expect(quietUntil(at(23, 59), 0, NIGHT)).toBe(at(31));
    expect(quietUntil(at(0, 0), 0, NIGHT)).toBe(at(7));
    expect(quietUntil(at(6, 59), 0, NIGHT)).toBe(at(7));
    expect(quietUntil(at(7, 0), 0, NIGHT)).toBeUndefined();
    expect(quietUntil(at(12), 0, NIGHT)).toBeUndefined();
  });

  it("window inside one day", () => {
    const lunch = { start: "12:00", end: "13:30" };
    expect(quietUntil(at(11, 59), 0, lunch)).toBeUndefined();
    expect(quietUntil(at(12, 0), 0, lunch)).toBe(at(13, 30));
    expect(quietUntil(at(13, 29), 0, lunch)).toBe(at(13, 30));
    expect(quietUntil(at(13, 30), 0, lunch)).toBeUndefined();
  });

  it("uses the user's local time: 17:00 UTC is 22:30 at UTC+5:30, quiet until 07:00 local = 01:30 UTC", () => {
    expect(quietUntil(at(17), 330, NIGHT)).toBe(at(25, 30));
    expect(quietUntil(at(17), 0, NIGHT)).toBeUndefined();
    // a negative offset: 03:00 UTC is 22:00 at UTC-5, quiet until 07:00 local = 12:00 UTC
    expect(quietUntil(at(3), -300, NIGHT)).toBe(at(12));
  });

  it("works for times before 1970 (negative epoch)", () => {
    const t = Date.UTC(1969, 11, 31, 23, 0);
    expect(quietUntil(t, 0, NIGHT)).toBe(Date.UTC(1970, 0, 1, 7, 0));
    // noon before 1970 is NOT quiet (a plain % gives a negative time of day and would call it quiet)
    expect(quietUntil(Date.UTC(1969, 11, 31, 12, 0), 0, NIGHT)).toBeUndefined();
  });
});

describe("preferences validation", () => {
  it("rejects bad times, equal start/end, unknown channels; keeps the old value", () => {
    const p = new PreferenceStore();
    p.set("u1", { mutedMarketing: ["sms"] });
    for (const bad of [
      { mutedMarketing: [], quietHours: { start: "24:00", end: "07:00" } },
      { mutedMarketing: [], quietHours: { start: "7:00", end: "08:00" } },
      { mutedMarketing: [], quietHours: { start: "22:00", end: "22:00" } },
      { mutedMarketing: ["fax"] },
      { mutedMarketing: "sms" },
    ]) {
      expect(errorCode(() => p.set("u1", bad as never))).toBe("INVALID_PREFERENCES");
    }
    expect(p.get("u1")).toEqual({ mutedMarketing: ["sms"] });
    expect(p.get("unknown")).toEqual({ mutedMarketing: [] });
  });

  it("returns copies: a caller cannot change stored preferences through the returned object", () => {
    const p = new PreferenceStore();
    p.set("u1", { mutedMarketing: ["sms"], quietHours: NIGHT });
    p.get("u1").mutedMarketing.push("email");
    p.get("u1").quietHours!.start = "00:00";
    expect(p.get("u1")).toEqual({ mutedMarketing: ["sms"], quietHours: NIGHT });
  });

  it("user directory validates the UTC offset", () => {
    const users = new InMemoryUsers();
    for (const bad of [-721, 841, 5.5, Number.NaN]) {
      expect(errorCode(() => users.upsert({ ...FULL_USER, utcOffsetMinutes: bad }))).toBe("INVALID_PREFERENCES");
    }
    expect(errorCode(() => users.upsert({ ...FULL_USER, userId: " " }))).toBe("INVALID_REQUEST");
    users.upsert({ ...FULL_USER, utcOffsetMinutes: 840 });
    expect(users.get("u1")?.utcOffsetMinutes).toBe(840);
  });
});

describe("planChannel: the one rule", () => {
  const quietMuted = { mutedMarketing: ["sms" as const], quietHours: NIGHT };
  const night = at(23);

  it("no address skips the channel for every category; a blank address counts as none", () => {
    const user = { userId: "u", email: "  " };
    expect(planChannel("transactional", "sms", user, { mutedMarketing: [] }, at(12))).toEqual({ status: "skipped", reason: "no_address" });
    expect(planChannel("marketing", "email", user, { mutedMarketing: [] }, at(12))).toEqual({ status: "skipped", reason: "no_address" });
  });

  it("transactional ignores mutes and quiet hours", () => {
    expect(planChannel("transactional", "sms", FULL_USER, quietMuted, night)).toEqual({ status: "pending", to: FULL_USER.phone });
    expect(planChannel("transactional", "push", FULL_USER, quietMuted, night)).toEqual({ status: "pending", to: FULL_USER.pushToken });
  });

  it("marketing: muted channel skipped (even outside quiet hours), sms/push deferred at night, email never deferred", () => {
    expect(planChannel("marketing", "sms", FULL_USER, quietMuted, at(12))).toEqual({ status: "skipped", reason: "opted_out" });
    expect(planChannel("marketing", "push", FULL_USER, quietMuted, night)).toEqual({ status: "deferred", to: FULL_USER.pushToken, notBefore: at(31) });
    expect(planChannel("marketing", "email", FULL_USER, quietMuted, night)).toEqual({ status: "pending", to: FULL_USER.email });
    expect(planChannel("marketing", "push", FULL_USER, quietMuted, at(12))).toEqual({ status: "pending", to: FULL_USER.pushToken });
  });

  it("a muted channel is skipped even in quiet hours (opted out wins over deferred)", () => {
    expect(planChannel("marketing", "sms", FULL_USER, quietMuted, night)).toEqual({ status: "skipped", reason: "opted_out" });
  });
});

describe("preferences from untrusted input (stage 3: HTTP bodies)", () => {
  it("not an object, or quietHours not an object -> INVALID_PREFERENCES, not a TypeError", () => {
    const store = new PreferenceStore();
    for (const bad of [null, "x", 7, { mutedMarketing: [], quietHours: null }, { mutedMarketing: [], quietHours: "22:00-07:00" }]) {
      expect(errorCode(() => store.set("u1", bad as never))).toBe("INVALID_PREFERENCES");
    }
  });
});
