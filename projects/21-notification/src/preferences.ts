// User preferences and quiet hours. The RULE for who respects what lives in policy.ts; this file only stores and
// validates the user's choices and does the clock arithmetic.
import { NotificationError } from "./errors.js";
import { isChannel, type Channel } from "./types.js";

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export interface QuietHours {
  start: string; // "22:00" local time, inclusive
  end: string; // "07:00" local time, exclusive; may be earlier than start (the window crosses midnight)
}

export interface Preferences {
  mutedMarketing: Channel[]; // marketing channels the user switched off (default: none)
  quietHours?: QuietHours;
}

const HH_MM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export function parseHhMm(value: string): number {
  const match = typeof value === "string" ? HH_MM.exec(value) : null;
  if (!match) throw new NotificationError("INVALID_PREFERENCES", `time must be HH:MM (00:00-23:59): ${String(value)}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function validateOffset(offsetMinutes: number): void {
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840) {
    throw new NotificationError("INVALID_PREFERENCES", `UTC offset must be an integer from -720 to 840 minutes`);
  }
}

// If `now` is inside the user's quiet hours, the epoch ms at which they end; otherwise undefined.
export function quietUntil(now: number, utcOffsetMinutes: number, quiet: QuietHours): number | undefined {
  const start = parseHhMm(quiet.start) * MINUTE_MS;
  const end = parseHhMm(quiet.end) * MINUTE_MS;
  const local = now + utcOffsetMinutes * MINUTE_MS;
  const intoDay = ((local % DAY_MS) + DAY_MS) % DAY_MS; // works for times before 1970 too
  const dayStart = local - intoDay;
  let endLocal: number;
  if (start < end) {
    if (intoDay < start || intoDay >= end) return undefined;
    endLocal = dayStart + end;
  } else {
    // crosses midnight: quiet from start to 24:00 and from 00:00 to end
    if (intoDay >= start) endLocal = dayStart + DAY_MS + end;
    else if (intoDay < end) endLocal = dayStart + end;
    else return undefined;
  }
  return endLocal - utcOffsetMinutes * MINUTE_MS;
}

export class PreferenceStore {
  private readonly prefs = new Map<string, Preferences>();

  set(userId: string, prefs: Preferences): void {
    if (!Array.isArray(prefs.mutedMarketing) || !prefs.mutedMarketing.every(isChannel)) {
      throw new NotificationError("INVALID_PREFERENCES", "mutedMarketing must be a list of channels");
    }
    if (prefs.quietHours !== undefined) {
      const start = parseHhMm(prefs.quietHours.start);
      const end = parseHhMm(prefs.quietHours.end);
      if (start === end) {
        throw new NotificationError("INVALID_PREFERENCES", "quiet hours start and end are equal (empty or whole day?)");
      }
    }
    this.prefs.set(userId, {
      mutedMarketing: [...new Set(prefs.mutedMarketing)],
      ...(prefs.quietHours ? { quietHours: { ...prefs.quietHours } } : {}),
    });
  }

  get(userId: string): Preferences {
    const stored = this.prefs.get(userId);
    return stored
      ? { mutedMarketing: [...stored.mutedMarketing], ...(stored.quietHours ? { quietHours: { ...stored.quietHours } } : {}) }
      : { mutedMarketing: [] };
  }
}
