/**
 * Transport to the brain.
 *
 * "server" posts the snapshot to /api/decide, which calls Jev with the API key
 * that never leaves the server. "local" runs the same question-building code
 * and answers it with the bundled simulator, so the page also works when it is
 * served as plain static files.
 */

import { buildRequest, interpret } from '../shared/brain.js';
import type { DecideBody, DecideResult, HealthInfo, Policy, Snapshot } from '../shared/protocol.js';
import { SIM_MODEL, simulateSystemOne } from '../shared/simulator.js';

export type LinkMode = 'server' | 'local';

const LOCAL_HEALTH: HealthInfo = { source: 'simulator', model: SIM_MODEL, version: 'local' };

export class JevLink {
  mode: LinkMode = 'local';
  health: HealthInfo = LOCAL_HEALTH;
  lastError: string | null = null;

  /** Empty in the browser (same origin); set by the headless bench runner. */
  constructor(private baseUrl = '') {}

  /** Ask the server what brain it has. Falls back to the local simulator. */
  async probe(): Promise<HealthInfo> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`health ${res.status}`);
      this.health = (await res.json()) as HealthInfo;
      this.mode = 'server';
      this.lastError = null;
    } catch {
      this.mode = 'local';
      this.health = LOCAL_HEALTH;
    }
    return this.health;
  }

  useLocal(): void {
    this.mode = 'local';
    this.health = LOCAL_HEALTH;
  }

  async decide(snapshot: Snapshot, policy: Partial<Policy>, snapshotAt: number): Promise<DecideResult> {
    if (this.mode === 'server') {
      try {
        const body: DecideBody = { snapshot, policy, snapshotAt };
        const res = await fetch(`${this.baseUrl}/api/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`decide ${res.status}: ${(await res.text()).slice(0, 160)}`);
        this.lastError = null;
        return (await res.json()) as DecideResult;
      } catch (err) {
        // Keep the gun alive on a transport hiccup, but say so.
        this.lastError = String((err as Error).message ?? err);
      }
    }
    return this.decideLocally(snapshot, policy, snapshotAt);
  }

  private async decideLocally(snapshot: Snapshot, policy: Partial<Policy>, snapshotAt: number): Promise<DecideResult> {
    const request = buildRequest(snapshot, SIM_MODEL);
    const t0 = performance.now();
    const response = await simulateSystemOne(request);
    const latencyMs = performance.now() - t0;
    const decision = interpret(snapshot, response, { source: 'simulator', latencyMs, snapshotAt }, policy);
    if (this.lastError) decision.note = decision.note ? `${decision.note}; ${this.lastError}` : this.lastError;
    return { decision, request, response };
  }
}
