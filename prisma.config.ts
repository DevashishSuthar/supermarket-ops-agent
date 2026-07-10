import 'dotenv/config';
import { defineConfig, env } from "prisma/config";

// CLI operations (db push, migrate, studio) need a DIRECT connection —
// Supabase's pooled/pgbouncer URL (port 6543) blocks the prepared
// statements these operations rely on. The app's runtime queries
// (lib/db.ts) use the pooled DATABASE_URL instead — that split is
// intentional, not a mistake.
export default defineConfig({
  schema: "prisma/schema.prisma",
  //   migrations: {
  //     path: "prisma/migrations",
  //   },
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_DIRECT_URL"),
  },
});