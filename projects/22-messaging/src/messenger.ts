// The messaging core: direct and group conversations, per-conversation sequence numbers, idempotent sends,
// per-recipient delivery/read receipts, presence/multiple devices and message edit/delete. Stage 1 was fully
// synchronous; stage 2 makes every mutation a real async round trip to a ConversationStore, which is the one
// place two operations on the SAME conversation can genuinely interleave. Every mutating call brackets its one
// await with a SYNCHRONOUS claim before it and an apply after (mirrors 23-password-manager's
// claimEntryOp/commit, itself mirrored from 17-parking-lot's reserve/confirm): a `pendingOps` counter for
// message ops (send/deliver/read/edit/delete) and a `revising` flag for membership changes, each excluding the
// other -- CONVERSATION_BUSY, the same role VAULT_BUSY plays in 23-password-manager.
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.js";
import { MessagingError } from "./errors.js";
import { type ConversationStore, InMemoryConversationStore, type PersistedConversation } from "./store.js";
import {
  RECEIPT_RANK,
  type Conversation,
  type ConversationKind,
  type Member,
  type Message,
  type Receipt,
  type ReceiptStatus,
} from "./types.js";
import type { UserDirectory } from "./users.js";

export const MAX_BODY_LENGTH = 4096;
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 255;
export const MAX_GROUP_NAME_LENGTH = 200;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface MessengerOptions {
  users: UserDirectory;
  clock?: Clock;
  newId?: () => string;
  store?: ConversationStore;
}

export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
}

interface IdempotencyEntry {
  body: string;
  messageId: string | null; // null while the send that claimed this key is still being committed
}

// The internal record. `revising`/`pendingOps` are concurrency bookkeeping, never exposed on the public
// Conversation shape returned to callers -- same split as VaultRecord vs VaultSummary in 23-password-manager.
interface ConversationRecord {
  id: string;
  kind: ConversationKind;
  name?: string;
  members: Member[];
  nextSeq: number;
  createdAt: number;
  revising: boolean; // true while an addMember/removeMember commit is in flight -- excludes message ops
  pendingOps: number; // count of in-flight send/deliver/read/edit/delete commits -- excludes revising
}

// The overall status shown to the SENDER: the worst (lowest-ranked) receipt among the recipients. A group message
// is "delivered" only once everyone has it, "read" only once everyone has read it -- the single/double/blue tick
// rule. No recipients at all (every other member has since left the group) is "sent": there is nothing to confirm,
// so it must not claim "read".
export function overallStatus(message: Message): ReceiptStatus {
  const receipts = Object.values(message.receipts);
  if (receipts.length === 0) return "sent";
  return receipts.reduce<ReceiptStatus>((worst, r) => (RECEIPT_RANK[r.status] < RECEIPT_RANK[worst] ? r.status : worst), "read");
}

export function encodeCursor(seq: number): string {
  return Buffer.from(`v1.${seq}`).toString("base64url");
}

export function decodeCursor(cursor: string): number {
  const match = /^v1\.(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || encodeCursor(Number(match[1])) !== cursor) throw new MessagingError("INVALID_CURSOR", "not a cursor this API returned");
  return Number(match[1]);
}

// arr is sorted ascending by seq. First index i with arr[i].seq > value.
function firstIndexSeqGreaterThan(arr: Message[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.seq <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// First index i with arr[i].seq >= value.
function firstIndexSeqAtLeast(arr: Message[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.seq < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Messenger {
  private readonly users: UserDirectory;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly store: ConversationStore;
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messagesByConversation = new Map<string, Message[]>(); // seq ascending
  private readonly messageById = new Map<string, Message>();
  private readonly directIndex = new Map<string, string>(); // "a|b" (sorted) -> conversationId
  private readonly idempotency = new Map<string, IdempotencyEntry>(); // "conv:sender:clientMessageId"
  private readonly conversationsByUser = new Map<string, Set<string>>(); // userId -> conversationIds they belong to
  // Presence is intentionally NOT in the store above -- see store.ts. userId -> set of connected deviceIds.
  private readonly onlineDevices = new Map<string, Set<string>>();

  constructor(options: MessengerOptions) {
    this.users = options.users;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => randomUUID());
    this.store = options.store ?? new InMemoryConversationStore();
  }

  // ---- conversations ----

  // Unique per unordered pair: calling this again for the same two users returns the SAME conversation.
  // Creation itself has nothing to race (it only ever runs once per pair, guarded by directIndex) and stays
  // fully synchronous, same as createVault in 23-password-manager.
  createDirectConversation(userIdA: string, userIdB: string): Conversation {
    if (userIdA === userIdB) throw new MessagingError("INVALID_REQUEST", "a direct conversation needs two different users");
    this.requireUser(userIdA);
    this.requireUser(userIdB);
    const key = [userIdA, userIdB].sort().join("|");
    const existingId = this.directIndex.get(key);
    if (existingId) return this.toConversation(this.conversations.get(existingId)!);
    const record: ConversationRecord = {
      id: this.newId(),
      kind: "direct",
      members: [userIdA, userIdB].map((userId) => ({ userId, role: "member", joinedAtSeq: 0 })),
      nextSeq: 1,
      createdAt: this.clock.now(),
      revising: false,
      pendingOps: 0,
    };
    this.registerConversation(record);
    this.directIndex.set(key, record.id);
    return this.toConversation(record);
  }

  createGroupConversation(ownerId: string, memberIds: string[], name: string): Conversation {
    if (typeof name !== "string" || name.trim() === "" || name.length > MAX_GROUP_NAME_LENGTH) {
      throw new MessagingError("INVALID_REQUEST", `name must be a non-empty string of at most ${MAX_GROUP_NAME_LENGTH} characters`);
    }
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw new MessagingError("INVALID_REQUEST", "a group needs at least one member besides the owner");
    }
    if (memberIds.includes(ownerId)) throw new MessagingError("INVALID_REQUEST", "ownerId must not be repeated in memberIds");
    if (new Set(memberIds).size !== memberIds.length) throw new MessagingError("INVALID_REQUEST", "memberIds has a duplicate");
    this.requireUser(ownerId);
    memberIds.forEach((id) => this.requireUser(id));
    const record: ConversationRecord = {
      id: this.newId(),
      kind: "group",
      name,
      members: [
        { userId: ownerId, role: "owner", joinedAtSeq: 0 },
        ...memberIds.map((userId) => ({ userId, role: "member" as const, joinedAtSeq: 0 })),
      ],
      nextSeq: 1,
      createdAt: this.clock.now(),
      revising: false,
      pendingOps: 0,
    };
    this.registerConversation(record);
    return this.toConversation(record);
  }

  // A new member sees messages from this moment on, not the group's history (see PLAN.md). Membership changes
  // replace the WHOLE `members` array (not a keyed map), so two of them racing on the same stale array can
  // silently undo each other -- `revising` serializes them, and also excludes any message op from reading a
  // member list that is mid-replace.
  async addMember(conversationId: string, actingUserId: string, newUserId: string): Promise<Conversation> {
    const record = this.requireConversationRecord(conversationId);
    if (record.kind !== "group") throw new MessagingError("INVALID_REQUEST", "only group conversations have members added");
    this.requireOwner(record, actingUserId);
    this.requireUser(newUserId);
    if (record.members.some((m) => m.userId === newUserId)) {
      throw new MessagingError("ALREADY_MEMBER", `${newUserId} is already a member of ${conversationId}`);
    }

    this.claimRevision(record);
    try {
      const newMembers = [...record.members, { userId: newUserId, role: "member" as const, joinedAtSeq: record.nextSeq - 1 }];
      await this.commit(record, newMembers, this.messagesByConversation.get(conversationId)!);
      record.members = newMembers; // only applied after the store confirms it
      let set = this.conversationsByUser.get(newUserId);
      if (!set) {
        set = new Set();
        this.conversationsByUser.set(newUserId, set);
      }
      set.add(conversationId);
      return this.toConversation(record);
    } finally {
      record.revising = false;
    }
  }

  // Stage 1 has no ownership transfer and no self-leave: only the owner removes members, and never themselves.
  async removeMember(conversationId: string, actingUserId: string, targetUserId: string): Promise<Conversation> {
    const record = this.requireConversationRecord(conversationId);
    if (record.kind !== "group") throw new MessagingError("INVALID_REQUEST", "only group conversations have members removed");
    this.requireOwner(record, actingUserId);
    const member = record.members.find((m) => m.userId === targetUserId);
    if (!member) throw new MessagingError("NOT_A_MEMBER", `${targetUserId} is not a member of ${conversationId}`);
    if (member.role === "owner") throw new MessagingError("CANNOT_REMOVE_OWNER", "the owner cannot be removed (no ownership transfer in stage 1)");

    this.claimRevision(record);
    try {
      const newMembers = record.members.filter((m) => m.userId !== targetUserId);
      await this.commit(record, newMembers, this.messagesByConversation.get(conversationId)!);
      record.members = newMembers; // only applied after the store confirms it
      this.conversationsByUser.get(targetUserId)?.delete(conversationId);
      return this.toConversation(record);
    } finally {
      record.revising = false;
    }
  }

  get(conversationId: string): Conversation | undefined {
    const record = this.conversations.get(conversationId);
    return record ? this.toConversation(record) : undefined;
  }

  // ---- messages ----

  // Idempotent on clientMessageId, scoped to (conversationId, senderId): a retried send with the SAME body returns
  // the original message and consumes no new sequence number; the same id with a DIFFERENT body is a conflict.
  // The idempotency check runs before membership is re-validated, so replaying a completed send never fails just
  // because the sender has since left the conversation (replaying is reading a result, not re-authorizing).
  //
  // The key itself is claimed SYNCHRONOUSLY, before any await (same discipline as claimOp/claimRevision): a real
  // async round trip means the map lookup above can no longer dedupe truly concurrent duplicates by itself --
  // two calls with the same key could both miss it before either one's commit has filled it in. Claiming a
  // placeholder entry up front makes every call after the first one see it immediately and get SEND_IN_FLIGHT
  // instead of silently creating a second message.
  async sendMessage(conversationId: string, senderId: string, body: string, clientMessageId: string): Promise<Message> {
    if (typeof body !== "string" || body.trim() === "" || body.length > MAX_BODY_LENGTH) {
      throw new MessagingError("INVALID_REQUEST", `body must be a non-empty string of at most ${MAX_BODY_LENGTH} characters`);
    }
    if (typeof clientMessageId !== "string" || clientMessageId.trim() === "" || clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
      throw new MessagingError("INVALID_REQUEST", `clientMessageId must be a non-empty string of at most ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters`);
    }
    const key = `${conversationId}:${senderId}:${clientMessageId}`;
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.messageId === null) throw new MessagingError("SEND_IN_FLIGHT", `a send with clientMessageId ${clientMessageId} is already being committed`);
      if (existing.body !== body) {
        throw new MessagingError("IDEMPOTENCY_CONFLICT", `clientMessageId ${clientMessageId} was used before with a different body`);
      }
      return this.cloneMessage(this.messageById.get(existing.messageId)!);
    }
    this.idempotency.set(key, { body, messageId: null }); // claimed now, before any await
    try {
      const record = this.requireConversationRecord(conversationId);
      this.requireMember(record, senderId);

      this.claimOp(record); // synchronous: fails fast if the conversation is being revised
      try {
        const now = this.clock.now();
        const seq = record.nextSeq++; // claimed synchronously, so two concurrent sends can never collide
        const receipts: Record<string, Receipt> = {};
        for (const member of record.members) {
          if (member.userId === senderId) continue;
          // A recipient already online gets auto-delivered: in a real system the push reaches a connected
          // device right away. An offline recipient's receipt catches up on their next connectDevice().
          receipts[member.userId] = this.isOnline(member.userId) ? { status: "delivered", at: now } : { status: "sent", at: now };
        }
        const message: Message = {
          id: this.newId(),
          conversationId,
          seq,
          senderId,
          clientMessageId,
          body,
          createdAt: now,
          edited: false,
          editedAt: null,
          deletedAt: null,
          receipts,
        };
        const liveMessages = this.messagesByConversation.get(conversationId)!;
        await this.commit(record, record.members, [...liveMessages, message]);
        liveMessages.push(message); // only applied after the store confirms it
        this.messageById.set(message.id, message);
        this.idempotency.set(key, { body, messageId: message.id }); // finalize the claim
        return this.cloneMessage(message);
      } finally {
        record.pendingOps--;
      }
    } catch (err) {
      this.idempotency.delete(key); // release the claim so a fresh retry is not permanently blocked
      throw err;
    }
  }

  // Delivery is acknowledged one message at a time, as each arrives over the wire. Idempotent: delivering an
  // already-delivered or already-read message does nothing and is not an error (a retried ack is normal). The
  // live status is re-checked right before applying (not just before the await), so an out-of-order resolve
  // relative to a concurrent markReadUpTo can never downgrade "read" back to "delivered".
  async markDelivered(conversationId: string, recipientId: string, messageId: string): Promise<Receipt> {
    const record = this.requireConversationRecord(conversationId);
    this.requireMember(record, recipientId);
    const message = this.requireMessage(conversationId, messageId);
    const receipt = this.requireReceipt(message, recipientId);
    if (receipt.status !== "sent") return { ...receipt }; // already delivered or read: nothing to persist

    this.claimOp(record);
    try {
      const now = this.clock.now();
      const liveMessages = this.messagesByConversation.get(conversationId)!;
      await this.commit(
        record,
        record.members,
        liveMessages.map((m) => (m.id === messageId ? { ...m, receipts: { ...m.receipts, [recipientId]: { status: "delivered", at: now } } } : m)),
      );
      if (message.receipts[recipientId]!.status === "sent") message.receipts[recipientId] = { status: "delivered", at: now };
      return { ...message.receipts[recipientId]! };
    } finally {
      record.pendingOps--;
    }
  }

  // Read receipts are sent in bulk -- "I have read everything up to this message" -- not one at a time: that is
  // what makes a whole screenful of ticks turn blue at once. Marking read implies delivered. A message that
  // arrives (or is itself delivered) AFTER uptoSeq is untouched: read-up-to is a snapshot of what was actually
  // seen, not "mark everything that exists right now". Each message's live status is re-checked right before
  // applying, so a slower call that started first can never overwrite a faster call's later "read" with a
  // stale timestamp.
  async markReadUpTo(conversationId: string, recipientId: string, uptoSeq: number): Promise<{ marked: number }> {
    if (!Number.isInteger(uptoSeq) || uptoSeq < 0) throw new MessagingError("INVALID_REQUEST", "uptoSeq must be a non-negative integer");
    const record = this.requireConversationRecord(conversationId);
    this.requireMember(record, recipientId);

    this.claimOp(record);
    try {
      const liveMessages = this.messagesByConversation.get(conversationId)!;
      const toMark = liveMessages.filter((m) => m.seq <= uptoSeq && m.receipts[recipientId] && m.receipts[recipientId]!.status !== "read");
      if (toMark.length === 0) return { marked: 0 };
      const now = this.clock.now();
      const toMarkIds = new Set(toMark.map((m) => m.id));
      await this.commit(
        record,
        record.members,
        liveMessages.map((m) => (toMarkIds.has(m.id) ? { ...m, receipts: { ...m.receipts, [recipientId]: { status: "read", at: now } } } : m)),
      );
      let marked = 0;
      for (const m of toMark) {
        if (m.receipts[recipientId]!.status !== "read") {
          m.receipts[recipientId] = { status: "read", at: now };
          marked++;
        }
      }
      return { marked };
    } finally {
      record.pendingOps--;
    }
  }

  // Sender-only. Receipts are untouched by an edit. If a deleteMessage for the SAME message lands first, that
  // delete wins and this edit is silently dropped -- a deleted message can never be resurrected by a racing
  // edit that started before the delete but finishes after it.
  async editMessage(conversationId: string, senderId: string, messageId: string, newBody: string): Promise<Message> {
    if (typeof newBody !== "string" || newBody.trim() === "" || newBody.length > MAX_BODY_LENGTH) {
      throw new MessagingError("INVALID_REQUEST", `body must be a non-empty string of at most ${MAX_BODY_LENGTH} characters`);
    }
    const record = this.requireConversationRecord(conversationId);
    const message = this.requireMessage(conversationId, messageId);
    if (message.senderId !== senderId) throw new MessagingError("SENDER_REQUIRED", `only the sender may edit message ${messageId}`);
    if (message.deletedAt !== null) throw new MessagingError("MESSAGE_DELETED", `message ${messageId} was deleted and cannot be edited`);

    this.claimOp(record);
    try {
      const now = this.clock.now();
      const liveMessages = this.messagesByConversation.get(conversationId)!;
      await this.commit(
        record,
        record.members,
        liveMessages.map((m) => (m.id === messageId ? { ...m, body: newBody, edited: true, editedAt: now } : m)),
      );
      if (message.deletedAt === null) {
        message.body = newBody;
        message.edited = true;
        message.editedAt = now;
      }
      return this.cloneMessage(message);
    } finally {
      record.pendingOps--;
    }
  }

  // Sender-only, idempotent (deleting an already-deleted message is a no-op). Delete-for-everyone clears the
  // body, it does not just flag it: a reader only ever learns `deletedAt !== null`, never the old content.
  async deleteMessage(conversationId: string, senderId: string, messageId: string): Promise<Message> {
    const record = this.requireConversationRecord(conversationId);
    const message = this.requireMessage(conversationId, messageId);
    if (message.senderId !== senderId) throw new MessagingError("SENDER_REQUIRED", `only the sender may delete message ${messageId}`);
    if (message.deletedAt !== null) return this.cloneMessage(message);

    this.claimOp(record);
    try {
      const now = this.clock.now();
      const liveMessages = this.messagesByConversation.get(conversationId)!;
      await this.commit(
        record,
        record.members,
        liveMessages.map((m) => (m.id === messageId ? { ...m, body: "", deletedAt: now } : m)),
      );
      message.body = "";
      message.deletedAt = now;
      return this.cloneMessage(message);
    } finally {
      record.pendingOps--;
    }
  }

  getMessage(conversationId: string, messageId: string): Message | undefined {
    const message = this.messageById.get(messageId);
    return message && message.conversationId === conversationId ? this.cloneMessage(message) : undefined;
  }

  // Newest first; `cursor` is the nextCursor of the previous page. Only messages sent after `memberId` joined are
  // visible (see PLAN.md) -- this is enforced here, at read time, not by hiding anything at send time.
  getMessages(conversationId: string, memberId: string, options: { limit?: number; cursor?: string } = {}): MessagePage {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new MessagingError("INVALID_REQUEST", `limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
    const record = this.requireConversationRecord(conversationId);
    const member = this.requireMember(record, memberId);
    const before = options.cursor === undefined ? Infinity : decodeCursor(options.cursor);
    const all = this.messagesByConversation.get(conversationId)!; // seq ascending
    const visibleStart = firstIndexSeqGreaterThan(all, member.joinedAtSeq);
    const end = firstIndexSeqAtLeast(all, before);
    const start = Math.max(visibleStart, end - limit);
    const items = all.slice(start, end).reverse().map((m) => this.cloneMessage(m));
    const nextCursor = start > visibleStart ? encodeCursor(all[start]!.seq) : null;
    return { items, nextCursor };
  }

  // ---- presence / multiple devices ----

  isOnline(userId: string): boolean {
    const devices = this.onlineDevices.get(userId);
    return !!devices && devices.size > 0;
  }

  // Registers a connected device for userId (several devices at once are fine: that is the whole point).
  // Going from zero connected devices to one (offline -> online) triggers catch-up: every "sent" receipt of
  // theirs, across every conversation they belong to, is bumped to "delivered" -- modelling a real client
  // fetching its backlog and acking delivery for everything it received while it was away. A conversation
  // that happens to be mid-revision at that moment is skipped, not retried here; the recipient's next
  // reconnect or explicit markDelivered will still catch it up.
  async connectDevice(userId: string, deviceId?: string): Promise<string> {
    this.requireUser(userId);
    const id = deviceId ?? this.newId();
    const wasOnline = this.isOnline(userId);
    let devices = this.onlineDevices.get(userId);
    if (!devices) {
      devices = new Set();
      this.onlineDevices.set(userId, devices);
    }
    devices.add(id);
    if (!wasOnline) await this.deliverPendingReceipts(userId);
    return id;
  }

  // Multi-device read sync needs no code here: receipts are keyed by userId, not deviceId, so reading on one
  // device is already visible from every other device of the same user (see receipts.test.ts / devices.test.ts).
  disconnectDevice(userId: string, deviceId: string): void {
    const devices = this.onlineDevices.get(userId);
    if (!devices || !devices.has(deviceId)) throw new MessagingError("UNKNOWN_DEVICE", `device ${deviceId} is not connected for ${userId}`);
    devices.delete(deviceId);
  }

  private async deliverPendingReceipts(userId: string): Promise<void> {
    const conversationIds = this.conversationsByUser.get(userId);
    if (!conversationIds) return;
    for (const conversationId of conversationIds) {
      const record = this.conversations.get(conversationId);
      if (!record) continue;
      const liveMessages = this.messagesByConversation.get(conversationId)!;
      const pending = liveMessages.filter((m) => m.receipts[userId]?.status === "sent");
      if (pending.length === 0) continue;
      try {
        this.claimOp(record);
      } catch {
        continue; // mid-revision right now: skip, the next reconnect or an explicit ack will catch this up
      }
      try {
        const now = this.clock.now();
        const pendingIds = new Set(pending.map((m) => m.id));
        await this.commit(
          record,
          record.members,
          liveMessages.map((m) => (pendingIds.has(m.id) ? { ...m, receipts: { ...m.receipts, [userId]: { status: "delivered", at: now } } } : m)),
        );
        for (const m of pending) if (m.receipts[userId]!.status === "sent") m.receipts[userId] = { status: "delivered", at: now };
      } finally {
        record.pendingOps--;
      }
    }
  }

  // ---- internals ----

  private registerConversation(record: ConversationRecord): void {
    this.conversations.set(record.id, record);
    this.messagesByConversation.set(record.id, []);
    for (const member of record.members) {
      let set = this.conversationsByUser.get(member.userId);
      if (!set) {
        set = new Set();
        this.conversationsByUser.set(member.userId, set);
      }
      set.add(record.id);
    }
  }

  private requireUser(userId: string): void {
    if (!this.users.get(userId)) throw new MessagingError("UNKNOWN_USER", `no user ${String(userId)}`);
  }

  private requireConversationRecord(conversationId: string): ConversationRecord {
    const record = this.conversations.get(conversationId);
    if (!record) throw new MessagingError("UNKNOWN_CONVERSATION", `no conversation ${String(conversationId)}`);
    return record;
  }

  private requireMember(record: ConversationRecord, userId: string): Member {
    const member = record.members.find((m) => m.userId === userId);
    if (!member) throw new MessagingError("NOT_A_MEMBER", `${userId} is not a member of ${record.id}`);
    return member;
  }

  private requireOwner(record: ConversationRecord, userId: string): Member {
    const member = this.requireMember(record, userId);
    if (member.role !== "owner") throw new MessagingError("OWNER_REQUIRED", `${userId} is not the owner of ${record.id}`);
    return member;
  }

  private requireMessage(conversationId: string, messageId: string): Message {
    const message = this.messageById.get(messageId);
    if (!message || message.conversationId !== conversationId) {
      throw new MessagingError("UNKNOWN_MESSAGE", `no message ${String(messageId)} in conversation ${String(conversationId)}`);
    }
    return message;
  }

  private requireReceipt(message: Message, recipientId: string): Receipt {
    const receipt = message.receipts[recipientId];
    if (!receipt) {
      const reason = recipientId === message.senderId ? "is the sender of" : "was never a recipient of (not a member when it was sent)";
      throw new MessagingError("UNKNOWN_MESSAGE", `${recipientId} ${reason} message ${message.id}`);
    }
    return receipt;
  }

  // A message op fails fast if the conversation is mid-revision; otherwise it joins the (possibly several)
  // other in-flight message ops. Mirrors claimEntryOp in 23-password-manager.
  private claimOp(record: ConversationRecord): void {
    if (record.revising) throw new MessagingError("CONVERSATION_BUSY", `conversation ${record.id} is being revised`);
    record.pendingOps++;
  }

  // A membership change excludes BOTH another membership change and any in-flight message op -- mirrors
  // changeMasterPassword's rotating + pendingEntryOps>0 check.
  private claimRevision(record: ConversationRecord): void {
    if (record.revising) throw new MessagingError("CONVERSATION_BUSY", `conversation ${record.id} is already being revised`);
    if (record.pendingOps > 0) throw new MessagingError("CONVERSATION_BUSY", `conversation ${record.id} has a message operation in flight`);
    record.revising = true;
  }

  private async commit(record: ConversationRecord, members: Member[], messages: Message[]): Promise<void> {
    const snapshot: PersistedConversation = {
      conversation: { id: record.id, kind: record.kind, name: record.name, members, nextSeq: record.nextSeq, createdAt: record.createdAt },
      messages,
    };
    await this.store.persist(snapshot);
  }

  private toConversation(record: ConversationRecord): Conversation {
    return structuredClone({ id: record.id, kind: record.kind, name: record.name, members: record.members, nextSeq: record.nextSeq, createdAt: record.createdAt });
  }

  private cloneMessage(message: Message): Message {
    return structuredClone(message);
  }
}
