/**
 * Server-side Jev access.
 *
 * With TYPESAFE_API_KEY set this is the real model, called through the official
 * SDK (which retries 429/529 with backoff for us). Without a key the same
 * interface is served by the local simulator, and every answer is labelled as
 * such all the way into the HUD.
 */

import type { DecisionSource } from '../shared/protocol.js';
import { SIM_MODEL, simulateSystemOne } from '../shared/simulator.js';
import type { SystemOneRequest, SystemOneResponse } from '../shared/typesafe.js';

export const DEFAULT_MODEL = process.env['TYPESAFE_MODEL'] ?? 'jev-latest';

export interface JevCallResult {
  response: SystemOneResponse;
  source: DecisionSource;
  latencyMs: number;
  /** Set when the real call failed and the simulator answered instead. */
  degraded?: string;
}

export interface JevBackend {
  readonly source: DecisionSource;
  readonly model: string;
  call(req: SystemOneRequest): Promise<JevCallResult>;
}

/** Minimal shape of the bits of @typesafe-ai/sdk we use. */
interface SdkClient {
  systemOne(request: { state: unknown; questions: unknown; model?: string }): Promise<SystemOneResponse>;
}

async function loadClient(apiKey: string): Promise<SdkClient> {
  const mod = (await import('@typesafe-ai/sdk')) as unknown as {
    TypeSafeClient: new (config: { apiKey: string; defaultModel: string; timeout: number }) => SdkClient;
  };
  return new mod.TypeSafeClient({ apiKey, defaultModel: DEFAULT_MODEL, timeout: 10_000 });
}

function simBackend(reason: string): JevBackend {
  console.log(`[jev] ${reason} -- answering with the local simulator`);
  return {
    source: 'simulator',
    model: SIM_MODEL,
    async call(req) {
      const t0 = Date.now();
      const response = await simulateSystemOne(req);
      return { response, source: 'simulator', latencyMs: Date.now() - t0 };
    },
  };
}

export async function createBackend(): Promise<JevBackend> {
  const apiKey = process.env['TYPESAFE_API_KEY']?.trim();
  if (!apiKey) return simBackend('no TYPESAFE_API_KEY');

  let client: SdkClient;
  try {
    client = await loadClient(apiKey);
  } catch (err) {
    return simBackend(`could not load @typesafe-ai/sdk (${describe(err)})`);
  }

  console.log(`[jev] live: ${DEFAULT_MODEL} via api.typesafe.ai`);
  return {
    source: 'jev',
    model: DEFAULT_MODEL,
    async call(req) {
      const t0 = Date.now();
      try {
        const response = await client.systemOne({ state: req.state, questions: req.questions, model: req.model });
        return { response, source: 'jev', latencyMs: Date.now() - t0 };
      } catch (err) {
        // A round should not die because one call did: answer it locally and
        // say so, rather than leaving the gun without a brain.
        const degraded = describe(err);
        console.warn(`[jev] call failed (${degraded}); falling back to the simulator for this decision`);
        const response = await simulateSystemOne(req, { delay: false });
        return { response, source: 'simulator', latencyMs: Date.now() - t0, degraded };
      }
    },
  };
}

function describe(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { status?: number; message?: string; name?: string };
    if (e.status) return `${e.name ?? 'APIError'} ${e.status}: ${e.message ?? ''}`.trim();
    if (e.message) return e.message;
  }
  return String(err);
}
