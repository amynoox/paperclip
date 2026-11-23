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
//
// A change of engine is the other way an agent comes to one of these engines, and the way the studio's roles get
// theirs. The route that changes it keeps only the engine-agnostic keys of the old configuration, and this key is not
// one of them: a steerable role that moved from one engine to the other came out not steerable, with nothing said
// (production, 22 Nov 2026: two roles had to be switched on again by hand). `withLiveSteeringCarriedOver` is applied
// there: what the request says is kept; else the value of the old configuration is carried over; else `true`.
export const LIVE_STEERING_KEY = "experimentalLiveSteering";

/** The engines that read the key. Another engine's configuration is left as it is. */
export const LIVE_STEERING_ADAPTER_TYPES: readonly string[] = ["claude_local", "codex_local"];

const own = (value: unknown, key: string) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key);

/** The configuration an agent has after a change of engine, for live steering only. */
export function withLiveSteeringCarriedOver(
  nextAdapterType: string | null | undefined,
  previousAdapterConfig: Record<string, unknown> | null | undefined,
  nextAdapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (!nextAdapterType || !LIVE_STEERING_ADAPTER_TYPES.includes(nextAdapterType)) return nextAdapterConfig;
  if (own(nextAdapterConfig, LIVE_STEERING_KEY)) return nextAdapterConfig;
  if (own(previousAdapterConfig, LIVE_STEERING_KEY)) return { ...nextAdapterConfig, [LIVE_STEERING_KEY]: previousAdapterConfig![LIVE_STEERING_KEY] };
  return { ...nextAdapterConfig, [LIVE_STEERING_KEY]: true };
}

export function withLiveSteeringDefault<T>(adapterType: string | null | undefined, adapterConfig: T): T {
  if (!adapterType || !LIVE_STEERING_ADAPTER_TYPES.includes(adapterType)) return adapterConfig;
  const config = adapterConfig && typeof adapterConfig === "object" && !Array.isArray(adapterConfig)
    ? adapterConfig as Record<string, unknown> : {};
  if (Object.prototype.hasOwnProperty.call(config, LIVE_STEERING_KEY)) return adapterConfig;
  return { ...config, [LIVE_STEERING_KEY]: true } as T;
}
