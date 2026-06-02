import { env } from "../config/env.js";
import { initializeDatabase } from "../db/sql.js";
import { createPasswordReset, ensureAdmin } from "../services/auth.js";

const args = process.argv.slice(2);

const getArg = (name: string) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : undefined;
};

const email = getArg("email");

const run = async () => {
  await initializeDatabase();
  await ensureAdmin();

  const result = await createPasswordReset(email);
  // eslint-disable-next-line no-console
  console.log(`Reset link sent to ${result.email}`);
  // eslint-disable-next-line no-console
  console.log(`Public base URL in use: ${env.PUBLIC_BASE_URL}`);
};

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to initiate admin reset:", error);
  process.exit(1);
});
