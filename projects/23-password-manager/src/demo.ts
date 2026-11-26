import { PasswordManager, generatePassword } from "./index.js";

const manager = new PasswordManager();

console.log("-- creating a vault --");
manager.createVault("alice", "correct-horse-battery-staple");
console.log(manager.getVault("alice")); // activeSessions: 0

console.log("\n-- two devices unlock the same vault --");
const phone = manager.unlock("alice", "correct-horse-battery-staple");
const laptop = manager.unlock("alice", "correct-horse-battery-staple");
console.log(manager.getVault("alice")); // activeSessions: 2

const githubPassword = generatePassword({ length: 20 });
await manager.addEntry(phone.sessionId, { title: "GitHub", username: "alice", password: githubPassword });
console.log("phone added GitHub; laptop can already see it:", await manager.listEntries(laptop.sessionId));

console.log("\n-- locking one device's session does not touch the other --");
manager.lock(phone.sessionId);
console.log("phone session active?", manager.isSessionActive(phone.sessionId));
console.log("laptop session active?", manager.isSessionActive(laptop.sessionId));

console.log("\n-- changing the master password invalidates every OTHER session --");
await manager.changeMasterPassword("alice", "correct-horse-battery-staple", "a-new-master-password");
console.log("laptop session active after the password changed?", manager.isSessionActive(laptop.sessionId));
try {
  await manager.listEntries(laptop.sessionId);
} catch (err) {
  console.log((err as Error).message);
}

console.log("\n-- the lost entry that stage 2 prevents: an add racing a password rotation --");
const fresh = manager.unlock("alice", "a-new-master-password");
const rotation = manager.changeMasterPassword("alice", "a-new-master-password", "yet-another-master-password");
try {
  await manager.addEntry(fresh.sessionId, { title: "Email", username: "alice@example.com", password: "x" });
} catch (err) {
  console.log(`add while rotating: ${(err as Error).message}`);
}
await rotation;
