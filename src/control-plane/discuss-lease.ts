// src/control-plane/discuss-lease.ts
// Spec 2026-06-01-web-terminal-discuss-design.md §5.2. Engine port; the real
// impl lives in web/discuss-ws.ts (factory `createDiscussLease`), so the
// engine module never USES the web layer at runtime. The `mountRoutes` typing
// is `import type { Hono }` — type-only, no runtime import — and the method
// itself is optional so the null variant satisfies the interface without
// shipping a Hono dependency to the daemon path.

import type { Hono } from 'hono';

export interface DiscussLease {
  /** Close any active discuss WS for `ticket`, await pty exit (bounded by
   *  pty_kill_timeout_ms), then mark `ticket` as dispatching so subsequent
   *  WS upgrades return 409 until `releaseDispatching`. Idempotent. */
  requireClearForDispatch(ticket: string): Promise<void>;
  releaseDispatching(ticket: string): void;
  /** True while a reservation is outstanding for `ticket`. */
  isDispatching(ticket: string): boolean;
  /** Active WS count across all tickets (for the global cap pre-upgrade check). */
  activeCount(): number;
  /** Daemon shutdown — reaps all ptys + closes all WS. */
  shutdown(): Promise<void>;
  /** Attach pre-upgrade middleware + WS route to the Hono app. Provided by the
   *  real (`createDiscussLease`) impl; omitted on the null variant. */
  mountRoutes?(app: Hono): void;
}

export const nullDiscussLease: DiscussLease = {
  async requireClearForDispatch() { /* no-op */ },
  releaseDispatching() { /* no-op */ },
  isDispatching() { return false; },
  activeCount() { return 0; },
  async shutdown() { /* no-op */ },
  /* mountRoutes intentionally omitted — optional. */
};
