import { createApp } from "./app.js";
import { connectDb, disconnectDb } from "./config/db.js";
import { env } from "./config/env.js";
import { logBrevoMisconfig } from "./services/brevoMail.service.js";
import { startStoryStatusCron } from "./cron/storiesStatus.cron.js";
import { initChatSocket } from "./socket/chatSocket.js";

const app = createApp();

async function main(): Promise<void> {
  await connectDb();

  const server = app.listen(env.port, () => {
    console.log(`API listening on http://localhost:${String(env.port)}`);
    logBrevoMisconfig();
    startStoryStatusCron();
    initChatSocket(server);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down…`);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
