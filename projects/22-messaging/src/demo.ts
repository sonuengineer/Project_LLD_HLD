// npm run demo -- a direct chat, a group chat, delivery/read receipts, a retried send, the join-time history
// cut, an offline recipient catching up on reconnect, multiple devices, and message edit/delete.
import { InMemoryUsers, ManualClock, Messenger, overallStatus } from "./index.js";

const clock = new ManualClock(Date.UTC(2026, 10, 26, 10, 0));
const users = new InMemoryUsers();
for (const [userId, displayName] of [["u1", "Asha"], ["u2", "Bilal"], ["u3", "Chen"]] as const) {
  users.upsert({ userId, displayName });
}
const messenger = new Messenger({ users, clock });

async function main() {
  const direct = messenger.createDirectConversation("u1", "u2");
  const m1 = await messenger.sendMessage(direct.id, "u1", "hey, free for a call?", "c-1");
  console.log("direct message status right after sending (u2 is offline):", overallStatus(m1));
  await messenger.markDelivered(direct.id, "u2", m1.id);
  console.log("after delivery:", overallStatus(messenger.getMessage(direct.id, m1.id)!));
  await messenger.markReadUpTo(direct.id, "u2", m1.seq);
  console.log("after u2 reads up to seq", m1.seq, ":", overallStatus(messenger.getMessage(direct.id, m1.id)!));

  const retry = await messenger.sendMessage(direct.id, "u1", "hey, free for a call?", "c-1"); // same client id, same body
  console.log("retry of the same send returns the same message:", retry.id === m1.id);

  const group = messenger.createGroupConversation("u1", ["u2"], "project chat");
  await messenger.sendMessage(group.id, "u1", "kickoff at 3pm", "g-1");
  await messenger.addMember(group.id, "u1", "u3"); // u3 joins AFTER the kickoff message
  const g2 = await messenger.sendMessage(group.id, "u1", "u3 just joined, welcome!", "g-2");
  console.log("group message status (u2 and u3 are both offline):", overallStatus(g2));
  await messenger.markDelivered(group.id, "u2", g2.id);
  await messenger.markDelivered(group.id, "u3", g2.id);
  console.log("once both u2 and u3 have it:", overallStatus(messenger.getMessage(group.id, g2.id)!));

  const page = messenger.getMessages(group.id, "u3", { limit: 10 });
  console.log("u3 sees", page.items.length, "message(s) (not the kickoff message sent before they joined)");

  // Presence and multiple devices.
  console.log("\n--- presence ---");
  const direct2 = messenger.createDirectConversation("u1", "u3");
  const before = await messenger.sendMessage(direct2.id, "u1", "u3, you there?", "p-1");
  console.log("sent while u3 is offline:", overallStatus(before));
  await messenger.connectDevice("u3", "u3-phone");
  console.log("u3's phone connects -> catch-up delivers the backlog:", overallStatus(messenger.getMessage(direct2.id, before.id)!));
  const whileOnline = await messenger.sendMessage(direct2.id, "u1", "great, got a sec?", "p-2");
  console.log("a NEW message sent while u3 is already online is auto-delivered:", overallStatus(whileOnline));
  await messenger.connectDevice("u3", "u3-laptop"); // a second device for the same user
  console.log("u3 is now on 2 devices at once:", messenger.isOnline("u3"));
  await messenger.markReadUpTo(direct2.id, "u3", whileOnline.seq); // read on the phone
  console.log("read on one device is visible from the other too (receipts are per-user, not per-device):",
    overallStatus(messenger.getMessage(direct2.id, whileOnline.id)!));

  // Edit and delete-for-everyone.
  console.log("\n--- edit / delete ---");
  const typo = await messenger.sendMessage(direct.id, "u1", "see you at 4pm", "e-1");
  const fixed = await messenger.editMessage(direct.id, "u1", typo.id, "see you at 5pm");
  console.log("edited message body:", fixed.body, "| edited:", fixed.edited);
  const oops = await messenger.sendMessage(direct.id, "u1", "wrong chat, ignore this", "e-2");
  const deleted = await messenger.deleteMessage(direct.id, "u1", oops.id);
  console.log("deleted message body is cleared:", JSON.stringify(deleted.body), "| deletedAt set:", deleted.deletedAt !== null);
}

await main();
