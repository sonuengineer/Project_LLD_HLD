// Stage 3: the in-app inbox (the bell icon with a count). The "provider" of the in_app channel: InboxSender stores the
// message here instead of calling anyone.
//
// Four things that look easy and are not:
//   - Paging while new items arrive. Newest first, so ?page=2 would shift down by every new arrival and show items
//     twice. The cursor is "everything older than the last item you got" (its sequence number), which no new arrival
//     can move. It is opaque (base64url of "v1.<seq>") so clients cannot build their own.
//   - The unread count. A stored counter (reading it is O(1) on every page load), changed ONLY when an item really
//     changes state: marking an already-read item does nothing, so two tabs marking the same item read decrement once.
//     (In SQL: UPDATE ... SET read_at = now() WHERE id = $1 AND read_at IS NULL, and decrement only if a row changed.)
//   - "Mark all read". It takes the newest item the user SAW: an item that arrives while the user clicks must not be
//     marked read unseen.
//   - Retries. A redelivered or retried job must not add the message twice: add() is keyed on the provider
//     idempotency key ("<notificationId>:in_app").
//
// Items are looked up inside one user's inbox only, so user A cannot mark user B's item read by guessing its id.
// Retention: at most `maxPerUser` items (default 200), the oldest dropped; an unread one dropped lowers the count.
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.js";
import { NotificationError } from "./errors.js";
import type { ChannelSender } from "./senders.js";
import type { OutboundMessage, SendResult } from "./types.js";

export interface InboxItem {
  id: string;
  notificationId: string;
  title?: string;
  body: string;
  createdAt: number;
  readAt?: number;
}

export interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null; // null: this was the last page
  unread: number;
}

export type MarkResult = "marked" | "already_read" | "not_found";

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

interface Entry extends InboxItem {
  seq: number;
  key: string;
}

interface Box {
  items: Entry[]; // oldest first (seq ascending): appended at the end, dropped from the front
  byId: Map<string, Entry>;
  byKey: Map<string, Entry>;
  unread: number;
}

export function encodeCursor(seq: number): string {
  return Buffer.from(`v1.${seq}`).toString("base64url");
}

export function decodeCursor(cursor: string): number {
  const match = /^v1\.(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || encodeCursor(Number(match[1])) !== cursor) throw new NotificationError("INVALID_CURSOR", "not a cursor this API returned");
  return Number(match[1]);
}

const view = (e: Entry): InboxItem => {
  const { seq: _s, key: _k, ...item } = e;
  return { ...item };
};

export class InMemoryInbox {
  private readonly boxes = new Map<string, Box>();
  private readonly maxPerUser: number;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private seq = 0;

  constructor(options: { maxPerUser?: number; clock?: Clock; newId?: () => string } = {}) {
    this.maxPerUser = options.maxPerUser ?? 200;
    if (!Number.isInteger(this.maxPerUser) || this.maxPerUser < 1) throw new RangeError("maxPerUser must be an integer >= 1");
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => randomUUID());
  }

  // Idempotent on `key`: the same key again returns the item already stored (while it is still in the inbox).
  add(userId: string, input: { key: string; notificationId: string; title?: string; body: string }): InboxItem {
    const box = this.box(userId);
    const existing = box.byKey.get(input.key);
    if (existing) return view(existing);
    const entry: Entry = {
      id: this.newId(),
      notificationId: input.notificationId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      body: input.body,
      createdAt: this.clock.now(),
      seq: ++this.seq,
      key: input.key,
    };
    box.items.push(entry);
    box.byId.set(entry.id, entry);
    box.byKey.set(entry.key, entry);
    box.unread++;
    while (box.items.length > this.maxPerUser) {
      const old = box.items.shift()!;
      box.byId.delete(old.id);
      box.byKey.delete(old.key);
      if (old.readAt === undefined) box.unread--;
    }
    return view(entry);
  }

  // Newest first. `cursor` is the nextCursor of the previous page.
  page(userId: string, options: { limit?: number; cursor?: string } = {}): InboxPage {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new NotificationError("INVALID_REQUEST", `limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
    const before = options.cursor === undefined ? Infinity : decodeCursor(options.cursor);
    const box = this.boxes.get(userId);
    if (!box) return { items: [], nextCursor: null, unread: 0 };
    // items is sorted by seq: find the first index at or after `before`, walk backwards from there.
    let end = box.items.length;
    let lo = 0;
    while (lo < end) {
      const mid = (lo + end) >> 1;
      if (box.items[mid]!.seq < before) lo = mid + 1;
      else end = mid;
    }
    const start = Math.max(0, end - limit);
    const items = box.items.slice(start, end).reverse();
    return { items: items.map(view), nextCursor: start > 0 ? encodeCursor(items.at(-1)!.seq) : null, unread: box.unread };
  }

  unreadCount(userId: string): number {
    return this.boxes.get(userId)?.unread ?? 0;
  }

  markRead(userId: string, itemId: string): MarkResult {
    const entry = this.boxes.get(userId)?.byId.get(itemId);
    if (!entry) return "not_found";
    if (entry.readAt !== undefined) return "already_read";
    entry.readAt = this.clock.now();
    this.boxes.get(userId)!.unread--;
    return "marked";
  }

  // Marks every unread item up to and including `upToItemId` (the newest one the user saw). Items that arrived after
  // it stay unread. Returns how many changed, or undefined if the item is not in this user's inbox.
  markAllRead(userId: string, upToItemId: string): number | undefined {
    const box = this.boxes.get(userId);
    const last = box?.byId.get(upToItemId);
    if (!box || !last) return undefined;
    const now = this.clock.now();
    let marked = 0;
    for (const entry of box.items) {
      if (entry.seq > last.seq) break;
      if (entry.readAt === undefined) {
        entry.readAt = now;
        marked++;
      }
    }
    box.unread -= marked;
    return marked;
  }

  private box(userId: string): Box {
    let box = this.boxes.get(userId);
    if (!box) {
      box = { items: [], byId: new Map(), byKey: new Map(), unread: 0 };
      this.boxes.set(userId, box);
    }
    return box;
  }
}

// The in_app channel's sender: "sending" is storing. The address (`to`) of an in_app message is the user id.
export class InboxSender implements ChannelSender {
  readonly channel = "in_app" as const;
  constructor(private readonly inbox: InMemoryInbox) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const item = this.inbox.add(message.to, {
      key: message.idempotencyKey,
      notificationId: message.notificationId,
      ...(message.subject !== undefined ? { title: message.subject } : {}),
      body: message.body,
    });
    return { status: "sent", providerId: item.id };
  }
}
