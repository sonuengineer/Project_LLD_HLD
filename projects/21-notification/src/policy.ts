// THE rule for one channel of one notification, in one place:
//   no address                          -> skipped (no_address)      [every category]
//   transactional                        -> pending (send now)        [ignores mutes and quiet hours]
//   marketing, channel muted             -> skipped (opted_out)
//   marketing, sms/push, in quiet hours  -> deferred until they end   [email is never deferred: it wakes nobody]
//   otherwise                            -> pending
import { quietUntil, type Preferences } from "./preferences.js";
import { addressFor, type Category, type Channel, type Recipient, type SkipReason } from "./types.js";

export type ChannelPlan =
  | { status: "pending"; to: string }
  | { status: "deferred"; to: string; notBefore: number }
  | { status: "skipped"; reason: SkipReason };

export const WAKES_USER: ReadonlySet<Channel> = new Set<Channel>(["sms", "push"]);

export function planChannel(
  category: Category,
  channel: Channel,
  recipient: Recipient,
  prefs: Preferences,
  now: number,
): ChannelPlan {
  const to = addressFor(recipient, channel);
  if (to === undefined) return { status: "skipped", reason: "no_address" };
  if (category === "transactional") return { status: "pending", to };
  if (prefs.mutedMarketing.includes(channel)) return { status: "skipped", reason: "opted_out" };
  if (prefs.quietHours && WAKES_USER.has(channel)) {
    const until = quietUntil(now, recipient.utcOffsetMinutes ?? 0, prefs.quietHours);
    if (until !== undefined) return { status: "deferred", to, notBefore: until };
  }
  return { status: "pending", to };
}
