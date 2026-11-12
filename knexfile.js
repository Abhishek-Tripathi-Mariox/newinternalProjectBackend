import 'dotenv/config';

const base = {
  client: 'pg',
  migrations: { directory: './src/db/migrations', tableName: 'knex_migrations', loadExtensions: ['.js'] },
  seeds: { directory: './src/db/seeds', loadExtensions: ['.js'] },
  pool: { min: 0, max: Number(process.env.DB_POOL_MAX || 10) },
};

/** Knex CLI config (migrations / seeds). The app itself uses src/db/knex.js. */
export default {
  development: { ...base, connection: process.env.DATABASE_URL },
  test: { ...base, connection: process.env.TEST_DATABASE_URL },
  production: { ...base, connection: process.env.DATABASE_URL },
};
