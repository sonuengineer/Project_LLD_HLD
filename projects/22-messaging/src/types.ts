// The shared vocabulary.

export type ConversationKind = "direct" | "group";

// sent < delivered < read. The overall status shown for a message is the WORST (lowest-ranked) of these across its
// recipients: a group message is "delivered" only once everyone has it, "read" only once everyone has read it.
export type ReceiptStatus = "sent" | "delivered" | "read";

export const RECEIPT_RANK: Record<ReceiptStatus, number> = { sent: 0, delivered: 1, read: 2 };

export interface User {
  userId: string;
  displayName: string;
}

export interface Member {
  userId: string;
  role: "owner" | "member";
  joinedAtSeq: number; // the conversation's message count at the moment this member joined
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  name?: string; // group only
  members: Member[];
  nextSeq: number; // the sequence number the NEXT message will get
  createdAt: number;
}

export interface Receipt {
  status: ReceiptStatus;
  at: number; // when this recipient reached this status
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number; // assigned at send time; defines order. NEVER compare messages by createdAt.
  senderId: string;
  clientMessageId: string; // the sender's idempotency key for this message
  body: string; // "" once deletedAt is set -- delete-for-everyone removes the content, not just a UI flag
  createdAt: number; // display only
  edited: boolean;
  editedAt: number | null;
  deletedAt: number | null; // set by deleteMessage; a delete in flight always wins over a racing edit
  receipts: Record<string, Receipt>; // userId -> receipt, one entry per OTHER member at send time
}
