// Loads apps/server/.env, if there is one. A module of its own so that an entry
// point can import it first: ES modules evaluate their imports in order, and
// the exporter reads some of its settings when it is loaded.
import path from 'node:path';

try {
  process.loadEnvFile(path.join(import.meta.dirname, '..', '.env'));
} catch {
  // no .env — rely on the environment
}
