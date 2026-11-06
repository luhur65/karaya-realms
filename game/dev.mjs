// Local dev launcher: node game/dev.mjs  ->  http://127.0.0.1:3078/realm/
// Serves game/index.html, the sliced sprites in ../assets and runs the realm server with a throwaway save dir.
import path from 'node:path';

const here = import.meta.dirname;
try {
  process.loadEnvFile(path.resolve(here, '..', '.env'));
} catch {}

process.env.PORT ||= '3078';
process.env.STATIC_DIR ||= here;
process.env.ASSETS_DIR ||= path.resolve(here, '..', 'assets');
process.env.DATA_DIR ||= path.join(here, 'data-dev');
await import('./server.mjs');
