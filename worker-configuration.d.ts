// Local contract augmentation; Wrangler-generated production types may replace this after activation.
import type { Env as AppEnv } from './src/env';
declare global {
    namespace Cloudflare {
        interface Env extends AppEnv {
            TEST_MIGRATIONS: import('@cloudflare/vitest-plugin').D1Migration[];
        }
    }
}
export {};
