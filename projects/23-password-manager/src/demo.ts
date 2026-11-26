import { PasswordManager, generatePassword } from "./index.js";

const manager = new PasswordManager();

console.log("-- creating a vault --");
manager.createVault("alice", "correct-horse-battery-staple");
console.log(manager.getVault("alice")); // unlocked: false

console.log("\n-- entries cannot be added while locked --");
try {
  manager.addEntry("alice", { title: "GitHub", username: "alice", password: "x" });
} catch (err) {
  console.log((err as Error).message);
}

console.log("\n-- unlocking and adding entries --");
manager.unlock("alice", "correct-horse-battery-staple");
const githubPassword = generatePassword({ length: 20 });
manager.addEntry("alice", { title: "GitHub", username: "alice", password: githubPassword, notes: "2FA via authenticator app" });
manager.addEntry("alice", { title: "Email", username: "alice@example.com", password: generatePassword() });
console.log(manager.listEntries("alice")); // titles/usernames, never a password

console.log("\n-- a wrong master password is recorded and eventually locks out --");
manager.lock("alice");
for (let i = 0; i < 5; i++) {
  try {
    manager.unlock("alice", "wrong-password-attempt");
  } catch (err) {
    console.log(`attempt ${i + 1}: ${(err as Error).message}`);
  }
}

console.log("\n-- raw export never contains the plaintext password --");
const dump = JSON.stringify(manager.exportVault("alice"));
console.log(`raw export contains the plaintext GitHub password? ${dump.includes(githubPassword)}`);
