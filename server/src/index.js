import { createApp } from './app.js';
import { config, reportGeneratedSecrets } from './config.js';
import { getDb } from './db.js';

getDb();

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`TagCheck listening on http://${config.host}:${config.port}`);
  console.log(`Club: ${config.clubName}  |  database: ${config.dbFile}`);
  reportGeneratedSecrets(console);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
