/**
 * Send gate (one application send per user operation).
 *
 * The "Continue" button starts a server action; a double click, a re-entrant
 * submit or an impatient second tap must never create a SECOND send request
 * for the same operation. React state alone cannot guarantee that (two clicks
 * in the same tick both read the previous render), so the guard is a plain
 * synchronous flag, framework-agnostic and unit-tested.
 */
export interface SendGate {
  /** True exactly once, for the first caller; false while a send runs. */
  begin(): boolean;
  /** Always release in a `finally` — success and failure alike. */
  end(): void;
  readonly inFlight: boolean;
}

export function createSendGate(): SendGate {
  let inFlight = false;
  return {
    begin() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    end() {
      inFlight = false;
    },
    get inFlight() {
      return inFlight;
    },
  };
}
