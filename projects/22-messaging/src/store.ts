// Where a conversation's durable state is written. Stage 1 was fully synchronous and needed no such boundary;
// stage 2 makes every mutation a real async round trip, which is the one place two operations on the SAME
// conversation can genuinely interleave -- mirrors 23-password-manager's VaultStore. Presence (who is online,
// on which device) is deliberately NOT part of this: it is ephemeral, like a real presence service (ask Redis
// with a TTL, not the durable message log), never written here. See Messenger.connectDevice/disconnectDevice.
import type { Conversation, Message } from "./types.js";

export interface PersistedConversation {
  conversation: Conversation;
  messages: Message[]; // seq ascending
}

export interface ConversationStore {
  persist(snapshot: PersistedConversation): Promise<void>;
}

// The default store: an in-memory sink that resolves on the next microtask, standing in for a fast real write.
// It still genuinely yields control, so two concurrent operations on the same conversation really do interleave
// around it -- the whole point of stage 2.
export class InMemoryConversationStore implements ConversationStore {
  private readonly snapshots = new Map<string, PersistedConversation>();

  async persist(snapshot: PersistedConversation): Promise<void> {
    await Promise.resolve();
    this.snapshots.set(snapshot.conversation.id, snapshot);
  }
}
