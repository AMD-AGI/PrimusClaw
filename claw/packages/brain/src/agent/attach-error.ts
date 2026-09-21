/**
 * The failure to OPEN a sandbox, as distinct from the failure of a tool call
 * made through one.
 *
 * Under `BRAIN_LAZY_SANDBOX` (default true, and true in the deployment) an
 * ordinary chat turn starts with no sandbox and opens one at the first tool
 * that needs `/workspace`. That open runs inside the tool-dispatch `try` in
 * `agent-loop`, whose `catch` turns anything thrown into result text for the
 * model -- which is right for a tool that ran and failed, and wrong for this.
 * Nothing ran. The turn never acquired the thing every later step assumes, and
 * the reason it did not is infrastructural rather than something the model can
 * respond to by trying a different argument.
 *
 * It matters because of what the swallowing costs. `ensureHands` raises
 * `DagHandleContendedError` for a lost CAS race precisely so `isRetryable` can
 * nak the delivery and have it redelivered; on the eager path (the task runner
 * awaiting `attachHands` itself) that works. On this path the class was turned
 * into a sentence, the model read the sentence, finished its turn, and the task
 * was ACKED -- reported `failed: false`, even. A redelivery that the error was
 * classified to earn was lost to where in the call stack it happened to be
 * raised, which is not a distinction anything should turn on.
 *
 * So the open is wrapped here, and `agent-loop` rethrows a wrapped error whose
 * `cause` `isRetryable` accepts. Deliberately not "rethrow everything the open
 * throws": a sandbox that cannot be built for a permanent reason -- a bad
 * image, a quota refusal -- is still better told to the model as text than
 * turned into a failed delivery, and those are the majority. Only the errors
 * already judged worth a second delivery get one.
 */
export class SandboxAttachError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SandboxAttachError";
    this.cause = cause;
  }
}

/**
 * Opens the sandbox, tagging a failure with where it happened.
 *
 * A function rather than a `try` inline in `engine.ts` so the wrapping can be
 * asserted on directly: the whole point of the class is that it survives the
 * trip to `agent-loop`'s catch, and a test that only drives the catch would
 * pass against an engine that had stopped wrapping.
 */
export async function attachOrWrap<T>(attach: () => Promise<T>): Promise<T> {
  try {
    return await attach();
  } catch (e) {
    throw new SandboxAttachError(e);
  }
}
