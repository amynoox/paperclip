// STUDIO-0096: a new agent is steerable while it works, unless its creation says otherwise.
//
// `experimentalLiveSteering` is a free key of an agent's adapter configuration, read as "exactly true" where a run is
// dispatched (services/adapter-interactive-control.ts) and by the two local engines that know it. Absent, it reads as
// off, and nothing wrote it for a new agent: a role created from the screen or through the API was never steerable
// until someone set the key by hand. The owner's decision of 23 Nov 2026: live steering is on for every role.
//
// The rule, applied where a new agent is written (modules/agent-lifecycle/adapters/records.ts), whatever asked for
// it: when the engine is one that reads the key and the creation says nothing of it, the server writes it `true`. A
// creation that carries the key keeps what it says, `false` included: an explicit value is a deliberate choice of
// whoever may write an agent's configuration. An agent that already exists is never touched here.
export const LIVE_STEERING_KEY = "experimentalLiveSteering";

/** The engines that read the key. Another engine's configuration is left as it is. */
export const LIVE_STEERING_ADAPTER_TYPES: readonly string[] = ["claude_local", "codex_local"];

export function withLiveSteeringDefault<T>(adapterType: string | null | undefined, adapterConfig: T): T {
  if (!adapterType || !LIVE_STEERING_ADAPTER_TYPES.includes(adapterType)) return adapterConfig;
  const config = adapterConfig && typeof adapterConfig === "object" && !Array.isArray(adapterConfig)
    ? adapterConfig as Record<string, unknown> : {};
  if (Object.prototype.hasOwnProperty.call(config, LIVE_STEERING_KEY)) return adapterConfig;
  return { ...config, [LIVE_STEERING_KEY]: true } as T;
}
