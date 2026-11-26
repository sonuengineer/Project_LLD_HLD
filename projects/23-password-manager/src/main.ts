// npm start -- the HTTP API with one fresh, empty PasswordManager. Configuration from the environment:
//   PASSWORD_MANAGER_API_KEY   required, at least 16 characters (never in the code or the repo)
//   PORT                       default 3000
//   HOST                       default 127.0.0.1 (this process only; nothing is exposed to the network
//                              unless you change it)
// Everything lives in memory only: restarting the process loses every vault. Ctrl+C shuts down cleanly.
import { createApp, MIN_API_KEY_LENGTH } from "./http/app.js";
import { startServer } from "./http/server.js";
import { PasswordManager } from "./index.js";

const apiKey = process.env.PASSWORD_MANAGER_API_KEY;
if (!apiKey || apiKey.length < MIN_API_KEY_LENGTH) {
  console.error(`Set PASSWORD_MANAGER_API_KEY (at least ${MIN_API_KEY_LENGTH} characters) to start the server.`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const manager = new PasswordManager();

const running = await startServer(createApp({ manager, apiKey }), { port, host });
console.log(`password manager API on ${running.url}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: finishing requests in progress...`);
    running.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
