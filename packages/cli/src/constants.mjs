export const COMMAND_NAME = 'workersphp';

export const log = (message) => console.error(`[${COMMAND_NAME}] ${message}`);

export class UsageError extends Error {}

export const USAGE = `usage: ${COMMAND_NAME} deploy --app <laravel-dir> --name <worker-name>
  [--d1 <db-name>] [--email <from-address>] [--queue <queue-name>]
  [--cron <expr> ...] [--broadcast] [--r2 <bucket>] [--kv <namespace>]
  [--domain <apex-domain>] [--wasm <vendor-dir>] [--env K=V ...]
  [--out <dir>] [--bake] [--no-deploy]`;
