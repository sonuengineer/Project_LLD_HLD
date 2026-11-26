import { BreachChecker, FakeBreachProvider, PasswordManager, generatePassword } from "./index.js";

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

console.log("\n-- breach checking: only a 5-character hash prefix ever leaves the vault --");
const breachManager = new PasswordManager({ breachChecker: new BreachChecker({ provider: new FakeBreachProvider() }) });
breachManager.createVault("bob", "correct-horse-battery-staple");
const bob = breachManager.unlock("bob", "correct-horse-battery-staple");
const weak = await breachManager.addEntry(bob.sessionId, { title: "Old site", username: "bob", password: "qwerty123" });
const strong = await breachManager.addEntry(bob.sessionId, { title: "Bank", username: "bob", password: generatePassword({ length: 24 }) });
console.log("a known-breached password:", weak.breached);
console.log("a freshly generated password:", strong.breached);

console.log("\n-- a broken breach-check service never blocks a save --");
const brokenBreachManager = new PasswordManager({
  breachChecker: new BreachChecker({ provider: { lookupPrefix: () => Promise.reject(new Error("service is down")) } }),
});
brokenBreachManager.createVault("carol", "correct-horse-battery-staple");
const carol = brokenBreachManager.unlock("carol", "correct-horse-battery-staple");
const savedAnyway = await brokenBreachManager.addEntry(carol.sessionId, { title: "GitHub", username: "carol", password: "x" });
console.log("saved despite the breach-check service being down; breached status:", savedAnyway.breached);
