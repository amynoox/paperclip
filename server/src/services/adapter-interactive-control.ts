import { createHash, randomUUID } from "node:crypto";
import type { AdapterExecutionContext, AdapterInteractiveControl } from "@paperclipai/adapter-utils";

export const ADAPTER_STEERING_EVENT = "adapter.steering.acknowledged";
export class AdapterSteeringError extends Error {
  constructor(readonly code: "steering_unsupported" | "steering_temporarily_unavailable" |
    "steering_stale_turn" | "steering_timeout" | "steering_rejected",
    message: string, readonly deliveryUncertain = false) { super(message); }
}

type Receipt = { turnId: string; correlationId: string };
type Owner = {
  companyId: string; runId: string; control: AdapterInteractiveControl;
  controller: AbortController; sourceInstanceId: string; sourceSeq: number;
  deliveries: Map<string, { digest: string; promise: Promise<Receipt> }>;
  persist: (receipt: Receipt & { phase: "attempt" | "acknowledged"; sourceInstanceId: string; sourceSeq: number }) => Promise<void>;
};
const owners = new Map<string, Owner>();
const key = (companyId: string, runId: string) => JSON.stringify([companyId, runId]);

/** Persist this dispatch choice; mutable settings must not reinterpret an old run. */
export function selectsAdapterInteractiveControl(run: {
  runtimeModeResolvedAt?: Date | null; runnerProfileJson?: Record<string, unknown> | null;
}, config: Record<string, unknown>) {
  return run.runtimeModeResolvedAt
    ? run.runnerProfileJson?.adapterInteractiveProtocol === "adapter_interactive_v1"
    : config.experimentalLiveSteering === true;
}

export function hasAdapterInteractiveControl(companyId: string, runId: string) {
  return owners.has(key(companyId, runId));
}
export function getAdapterInteractiveSteeringState(companyId: string, runId: string) {
  const owner = owners.get(key(companyId, runId));
  if (!owner || owner.controller.signal.aborted)
    return { disposition: "temporarily_unavailable" as const, activeTurnId: null };
  try {
    const state = owner.control.snapshot();
    return { disposition: !state.steering ? "unsupported" as const : state.activeTurnId
      ? "available" as const : "temporarily_unavailable" as const,
      activeTurnId: state.activeTurnId || null };
  } catch { return { disposition: "temporarily_unavailable" as const, activeTurnId: null }; }
}

/** Extends the existing execution lifetime, never stop/collection authority. */
export async function withAdapterInteractiveControl<T>(
  context: AdapterExecutionContext,
  execute: (context: AdapterExecutionContext) => Promise<T>,
  persist: Owner["persist"],
): Promise<T> {
  if (context.config.experimentalLiveSteering !== true) return execute(context);
  let current: Owner | null = null;
  let finished = false;
  // Correlations belong to the entire run, including MCP refresh phase gaps.
  const deliveries: Owner["deliveries"] = new Map();
  const scope = key(context.agent.companyId, context.runId);
  const dispose = () => {
    if (!current) return;
    if (owners.get(scope) === current) owners.delete(scope);
    current.controller.abort(new Error("Interactive execution detached"));
    current = null;
  };
  const onAbort = () => { finished = true; dispose(); };
  context.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await execute({ ...context, registerInteractiveControl(control) {
      if (finished || context.signal?.aborted) throw new Error("Interactive execution is no longer active");
      if (owners.has(scope) || current) throw new Error("Interactive control already registered");
      if (control.protocol !== "adapter_interactive_v1" || typeof control.snapshot !== "function" || typeof control.steer !== "function")
        throw new Error("Invalid interactive control contract");
      const owner: Owner = { companyId: context.agent.companyId, runId: context.runId, control,
        controller: new AbortController(), sourceInstanceId: `adapter-interactive:${randomUUID()}`,
        sourceSeq: 0, deliveries, persist };
      owners.set(scope, owner); current = owner;
      return () => { if (current === owner) dispose(); };
    } });
  } finally {
    finished = true; dispose(); context.signal?.removeEventListener("abort", onAbort);
  }
}

/** ACK is persisted by the host before it can authorize queue consumption. */
export async function steerAdapterInteractive(input: {
  companyId: string; runId: string; message: string; correlationId: string;
  timeoutMs?: number; onAcknowledged?: () => Promise<void>;
}): Promise<{ turnId: string }> {
  const owner = owners.get(key(input.companyId, input.runId));
  if (!owner || owner.controller.signal.aborted)
    throw new AdapterSteeringError("steering_temporarily_unavailable", "The interactive adapter is not attached.");
  const digest = createHash("sha256").update(input.message).digest("hex");
  let delivery = owner.deliveries.get(input.correlationId);
  if (delivery && delivery.digest !== digest)
    throw new AdapterSteeringError("steering_rejected", "The message identity was reused with different content.", true);
  if (!delivery) {
    const state = getAdapterInteractiveSteeringState(input.companyId, input.runId);
    if (state.disposition === "unsupported") throw new AdapterSteeringError("steering_unsupported", "This adapter cannot steer the current turn.");
    if (!state.activeTurnId) throw new AdapterSteeringError("steering_stale_turn", "The target turn is no longer active.");
    const turnId = state.activeTurnId;
    const promise = Promise.resolve().then(async () => {
      // No async observation may grant authority after cancellation or replacement.
      if (owners.get(key(input.companyId, input.runId)) !== owner || owner.controller.signal.aborted)
        throw new AdapterSteeringError("steering_temporarily_unavailable", "The interactive adapter detached before delivery.");
      if (owner.control.snapshot().activeTurnId !== turnId)
        throw new AdapterSteeringError("steering_stale_turn", "The target turn changed before delivery.");
      try {
        await owner.persist({ turnId, correlationId: input.correlationId, phase: "attempt",
          sourceInstanceId: owner.sourceInstanceId, sourceSeq: ++owner.sourceSeq });
      } catch {
        throw new AdapterSteeringError("steering_rejected", "A delivery attempt could not be reserved or already exists. The message remains queued.", true);
      }
      if (owners.get(key(input.companyId, input.runId)) !== owner || owner.controller.signal.aborted || owner.control.snapshot().activeTurnId !== turnId)
        throw new AdapterSteeringError("steering_stale_turn", "The target changed after reserving delivery. The message remains queued.", true);
      let receipt: Receipt;
      try {
        receipt = await owner.control.steer({ expectedTurnId: turnId, correlationId: input.correlationId,
          message: input.message, signal: owner.controller.signal });
      } catch {
        // A rejected promise cannot prove that a remote provider did not accept.
        throw new AdapterSteeringError("steering_rejected", "Delivery could not be confirmed. The message remains queued.", true);
      }
      if (receipt.turnId !== turnId || receipt.correlationId !== input.correlationId)
        throw new AdapterSteeringError("steering_rejected", "The provider acknowledgement did not match the message.", true);
      try { await owner.persist({ ...receipt, phase: "acknowledged", sourceInstanceId: owner.sourceInstanceId, sourceSeq: ++owner.sourceSeq }); }
      catch { throw new AdapterSteeringError("steering_rejected", "Acknowledgement could not be saved. The message remains queued.", true); }
      return receipt;
    });
    delivery = { digest, promise }; owner.deliveries.set(input.correlationId, delivery);
    // Retain failed/ambiguous correlations for this owner; never resend automatically.
    void promise.catch(() => undefined);
  }
  if (input.onAcknowledged) void delivery.promise.then(input.onAcknowledged).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([delivery.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AdapterSteeringError("steering_timeout",
        "The provider has not acknowledged the message. It remains queued.", true)), input.timeoutMs ?? 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
