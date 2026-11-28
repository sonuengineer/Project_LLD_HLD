// npm start -- the HTTP API with one fresh, empty Messenger. Configuration from the environment:
//   MESSAGING_API_KEY   required, at least 16 characters (never in the code or the repo)
//   PORT                default 3000
//   HOST                default 127.0.0.1 (this process only; nothing is exposed to the network unless you
//                        change it)
// Everything lives in memory only: restarting the process loses every conversation, message and presence
// connection. Ctrl+C shuts down cleanly.
//
// There is no HTTP route to register a user: Messenger takes a UserDirectory as a constructor dependency, it
// does not own user management itself (see users.ts), and this stage only wraps Messenger's own public API --
// not inventing an endpoint for something the library does not expose. A real deployment would inject a
// UserDirectory backed by the app's actual user service instead of this empty InMemoryUsers.
import { createApp, MIN_API_KEY_LENGTH } from "./http/app.js";
import { startServer } from "./http/server.js";
import { Messenger } from "./messenger.js";
import { InMemoryUsers } from "./users.js";

const apiKey = process.env.MESSAGING_API_KEY;
if (!apiKey || apiKey.length < MIN_API_KEY_LENGTH) {
  console.error(`Set MESSAGING_API_KEY (at least ${MIN_API_KEY_LENGTH} characters) to start the server.`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const messenger = new Messenger({ users: new InMemoryUsers() });

const running = await startServer(createApp({ messenger, apiKey }), { port, host });
console.log(`messaging API on ${running.url}`);

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
