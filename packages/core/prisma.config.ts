/**
 * Prisma 7 CLI configuration (migrate, generate, studio).
 *
 * Layer: config.
 *
 * The CLI only needs a connection string for migration and introspection commands; it is taken
 * from `DATABASE_URL`, which the root scripts export from `.env.local` (no dotenv auto-loading).
 * When the variable is absent the same instance derivation as the application applies, so a bare
 * `prisma migrate deploy` inside the default checkout targets the default compose database.
 */
import { defineConfig } from 'prisma/config';

import { loadConfig } from './src/config/schema.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: loadConfig().DATABASE_URL,
  },
});
