// src/control-plane/slots.ts
// Spec §10: synchronous, in-memory active-slot counter. Seeded from phases,
// incremented on entering a ⊕ phase, decremented on leaving. Caller reserves
// BEFORE any async write so two ticks can't over-commit.

import { type Phase, isSlotPhase } from './phase.js';

export class SlotCounter {
  private count = 0;
  constructor(public readonly cap: number) {}

  /** Seed the active count from the current phases of all known tasks. */
  seedFrom(phases: Iterable<Phase>): void {
    this.count = 0;
    for (const p of phases) if (isSlotPhase(p)) this.count += 1;
  }

  get active(): number {
    return this.count;
  }

  /** Reserve a slot synchronously. Returns false if at cap (caller does not dispatch). */
  tryReserve(): boolean {
    if (this.count >= this.cap) return false;
    this.count += 1;
    return true;
  }

  /** Release a slot. Floors at zero (defensive against double-release). */
  release(): void {
    if (this.count > 0) this.count -= 1;
  }
}
