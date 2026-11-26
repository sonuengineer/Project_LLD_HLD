// npm run demo -- a direct chat, a group chat, delivery/read receipts, a retried send, and the join-time history cut.
import { InMemoryUsers, ManualClock, Messenger, overallStatus } from "./index.js";

const clock = new ManualClock(Date.UTC(2026, 10, 26, 10, 0));
const users = new InMemoryUsers();
for (const [userId, displayName] of [["u1", "Asha"], ["u2", "Bilal"], ["u3", "Chen"]] as const) {
  users.upsert({ userId, displayName });
}
const messenger = new Messenger({ users, clock });

const direct = messenger.createDirectConversation("u1", "u2");
const m1 = messenger.sendMessage(direct.id, "u1", "hey, free for a call?", "c-1");
console.log("direct message status right after sending:", overallStatus(m1));
messenger.markDelivered(direct.id, "u2", m1.id);
console.log("after delivery:", overallStatus(messenger.getMessage(direct.id, m1.id)!));
messenger.markReadUpTo(direct.id, "u2", m1.seq);
console.log("after u2 reads up to seq", m1.seq, ":", overallStatus(messenger.getMessage(direct.id, m1.id)!));

const retry = messenger.sendMessage(direct.id, "u1", "hey, free for a call?", "c-1"); // same client id, same body
console.log("retry of the same send returns the same message:", retry.id === m1.id);

const group = messenger.createGroupConversation("u1", ["u2"], "project chat");
messenger.sendMessage(group.id, "u1", "kickoff at 3pm", "g-1");
messenger.addMember(group.id, "u1", "u3"); // u3 joins AFTER the kickoff message
const g2 = messenger.sendMessage(group.id, "u1", "u3 just joined, welcome!", "g-2");
console.log("group message status (u2 has not acked yet):", overallStatus(g2));
messenger.markDelivered(group.id, "u2", g2.id);
messenger.markDelivered(group.id, "u3", g2.id);
console.log("once both u2 and u3 have it:", overallStatus(messenger.getMessage(group.id, g2.id)!));

const page = messenger.getMessages(group.id, "u3", { limit: 10 });
console.log("u3 sees", page.items.length, "message(s) (not the kickoff message sent before they joined)");
