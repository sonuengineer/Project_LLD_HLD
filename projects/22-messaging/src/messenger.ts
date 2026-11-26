// The messaging core: direct and group conversations, per-conversation sequence numbers, idempotent sends and
// per-recipient delivery/read receipts. Fully synchronous (see PLAN.md): every call either completes or throws
// in one CPU turn -- an error means nothing happened. Stage 2 adds real concurrency on top of this.
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.js";
import { MessagingError } from "./errors.js";
import { RECEIPT_RANK, type Conversation, type Member, type Message, type Receipt, type ReceiptStatus } from "./types.js";
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
}

export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
}

interface IdempotencyEntry {
  body: string;
  messageId: string;
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
  private readonly conversations = new Map<string, Conversation>();
  private readonly messagesByConversation = new Map<string, Message[]>(); // seq ascending
  private readonly messageById = new Map<string, Message>();
  private readonly directIndex = new Map<string, string>(); // "a|b" (sorted) -> conversationId
  private readonly idempotency = new Map<string, IdempotencyEntry>(); // "conv:sender:clientMessageId"

  constructor(options: MessengerOptions) {
    this.users = options.users;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => randomUUID());
  }

  // ---- conversations ----

  // Unique per unordered pair: calling this again for the same two users returns the SAME conversation.
  createDirectConversation(userIdA: string, userIdB: string): Conversation {
    if (userIdA === userIdB) throw new MessagingError("INVALID_REQUEST", "a direct conversation needs two different users");
    this.requireUser(userIdA);
    this.requireUser(userIdB);
    const key = [userIdA, userIdB].sort().join("|");
    const existingId = this.directIndex.get(key);
    if (existingId) return this.cloneConversation(this.conversations.get(existingId)!);
    const conversation: Conversation = {
      id: this.newId(),
      kind: "direct",
      members: [userIdA, userIdB].map((userId) => ({ userId, role: "member", joinedAtSeq: 0 })),
      nextSeq: 1,
      createdAt: this.clock.now(),
    };
    this.store(conversation);
    this.directIndex.set(key, conversation.id);
    return this.cloneConversation(conversation);
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
    const conversation: Conversation = {
      id: this.newId(),
      kind: "group",
      name,
      members: [
        { userId: ownerId, role: "owner", joinedAtSeq: 0 },
        ...memberIds.map((userId) => ({ userId, role: "member" as const, joinedAtSeq: 0 })),
      ],
      nextSeq: 1,
      createdAt: this.clock.now(),
    };
    this.store(conversation);
    return this.cloneConversation(conversation);
  }

  // A new member sees messages from this moment on, not the group's history (see PLAN.md).
  addMember(conversationId: string, actingUserId: string, newUserId: string): Conversation {
    const conversation = this.requireConversation(conversationId);
    if (conversation.kind !== "group") throw new MessagingError("INVALID_REQUEST", "only group conversations have members added");
    this.requireOwner(conversation, actingUserId);
    this.requireUser(newUserId);
    if (conversation.members.some((m) => m.userId === newUserId)) {
      throw new MessagingError("ALREADY_MEMBER", `${newUserId} is already a member of ${conversationId}`);
    }
    conversation.members.push({ userId: newUserId, role: "member", joinedAtSeq: conversation.nextSeq - 1 });
    return this.cloneConversation(conversation);
  }

  // Stage 1 has no ownership transfer and no self-leave: only the owner removes members, and never themselves.
  removeMember(conversationId: string, actingUserId: string, targetUserId: string): Conversation {
    const conversation = this.requireConversation(conversationId);
    if (conversation.kind !== "group") throw new MessagingError("INVALID_REQUEST", "only group conversations have members removed");
    this.requireOwner(conversation, actingUserId);
    const member = conversation.members.find((m) => m.userId === targetUserId);
    if (!member) throw new MessagingError("NOT_A_MEMBER", `${targetUserId} is not a member of ${conversationId}`);
    if (member.role === "owner") throw new MessagingError("CANNOT_REMOVE_OWNER", "the owner cannot be removed (no ownership transfer in stage 1)");
    conversation.members = conversation.members.filter((m) => m.userId !== targetUserId);
    return this.cloneConversation(conversation);
  }

  get(conversationId: string): Conversation | undefined {
    const conversation = this.conversations.get(conversationId);
    return conversation ? this.cloneConversation(conversation) : undefined;
  }

  // ---- messages ----

  // Idempotent on clientMessageId, scoped to (conversationId, senderId): a retried send with the SAME body returns
  // the original message and consumes no new sequence number; the same id with a DIFFERENT body is a conflict.
  // The idempotency check runs before membership is re-validated, so replaying a completed send never fails just
  // because the sender has since left the conversation (replaying is reading a result, not re-authorizing).
  sendMessage(conversationId: string, senderId: string, body: string, clientMessageId: string): Message {
    if (typeof body !== "string" || body.trim() === "" || body.length > MAX_BODY_LENGTH) {
      throw new MessagingError("INVALID_REQUEST", `body must be a non-empty string of at most ${MAX_BODY_LENGTH} characters`);
    }
    if (typeof clientMessageId !== "string" || clientMessageId.trim() === "" || clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
      throw new MessagingError("INVALID_REQUEST", `clientMessageId must be a non-empty string of at most ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters`);
    }
    const key = `${conversationId}:${senderId}:${clientMessageId}`;
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.body !== body) {
        throw new MessagingError("IDEMPOTENCY_CONFLICT", `clientMessageId ${clientMessageId} was used before with a different body`);
      }
      return this.cloneMessage(this.messageById.get(existing.messageId)!);
    }
    const conversation = this.requireConversation(conversationId);
    this.requireMember(conversation, senderId);
    const now = this.clock.now();
    const seq = conversation.nextSeq++;
    const receipts: Record<string, Receipt> = {};
    for (const member of conversation.members) {
      if (member.userId === senderId) continue;
      receipts[member.userId] = { status: "sent", at: now };
    }
    const message: Message = { id: this.newId(), conversationId, seq, senderId, clientMessageId, body, createdAt: now, receipts };
    this.messagesByConversation.get(conversationId)!.push(message);
    this.messageById.set(message.id, message);
    this.idempotency.set(key, { body, messageId: message.id });
    return this.cloneMessage(message);
  }

  // Delivery is acknowledged one message at a time, as each arrives over the wire. Idempotent: delivering an
  // already-delivered or already-read message does nothing and is not an error (a retried ack is normal).
  markDelivered(conversationId: string, recipientId: string, messageId: string): Receipt {
    const conversation = this.requireConversation(conversationId);
    this.requireMember(conversation, recipientId);
    const message = this.requireMessage(conversationId, messageId);
    const receipt = this.requireReceipt(message, recipientId);
    if (receipt.status === "sent") message.receipts[recipientId] = { status: "delivered", at: this.clock.now() };
    return { ...message.receipts[recipientId]! };
  }

  // Read receipts are sent in bulk -- "I have read everything up to this message" -- not one at a time: that is
  // what makes a whole screenful of ticks turn blue at once. Marking read implies delivered. A message that
  // arrives (or is itself delivered) AFTER uptoSeq is untouched: read-up-to is a snapshot of what was actually
  // seen, not "mark everything that exists right now".
  markReadUpTo(conversationId: string, recipientId: string, uptoSeq: number): { marked: number } {
    if (!Number.isInteger(uptoSeq) || uptoSeq < 0) throw new MessagingError("INVALID_REQUEST", "uptoSeq must be a non-negative integer");
    const conversation = this.requireConversation(conversationId);
    this.requireMember(conversation, recipientId);
    const now = this.clock.now();
    let marked = 0;
    for (const message of this.messagesByConversation.get(conversationId)!) {
      if (message.seq > uptoSeq) break; // ascending order: nothing further can be <= uptoSeq
      const receipt = message.receipts[recipientId];
      if (receipt && receipt.status !== "read") {
        message.receipts[recipientId] = { status: "read", at: now };
        marked++;
      }
    }
    return { marked };
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
    const conversation = this.requireConversation(conversationId);
    const member = this.requireMember(conversation, memberId);
    const before = options.cursor === undefined ? Infinity : decodeCursor(options.cursor);
    const all = this.messagesByConversation.get(conversationId)!; // seq ascending
    const visibleStart = firstIndexSeqGreaterThan(all, member.joinedAtSeq);
    const end = firstIndexSeqAtLeast(all, before);
    const start = Math.max(visibleStart, end - limit);
    const items = all.slice(start, end).reverse().map((m) => this.cloneMessage(m));
    const nextCursor = start > visibleStart ? encodeCursor(all[start]!.seq) : null;
    return { items, nextCursor };
  }

  // ---- internals ----

  private store(conversation: Conversation): void {
    this.conversations.set(conversation.id, conversation);
    this.messagesByConversation.set(conversation.id, []);
  }

  private requireUser(userId: string): void {
    if (!this.users.get(userId)) throw new MessagingError("UNKNOWN_USER", `no user ${String(userId)}`);
  }

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new MessagingError("UNKNOWN_CONVERSATION", `no conversation ${String(conversationId)}`);
    return conversation;
  }

  private requireMember(conversation: Conversation, userId: string): Member {
    const member = conversation.members.find((m) => m.userId === userId);
    if (!member) throw new MessagingError("NOT_A_MEMBER", `${userId} is not a member of ${conversation.id}`);
    return member;
  }

  private requireOwner(conversation: Conversation, userId: string): Member {
    const member = this.requireMember(conversation, userId);
    if (member.role !== "owner") throw new MessagingError("OWNER_REQUIRED", `${userId} is not the owner of ${conversation.id}`);
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

  private cloneConversation(conversation: Conversation): Conversation {
    return structuredClone(conversation);
  }

  private cloneMessage(message: Message): Message {
    return structuredClone(message);
  }
}
