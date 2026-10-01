import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createSendGate } from "@/lib/send-gate";

/**
 * Send-applications loading state (Phase 19).
 *
 * The project has no DOM test stack (node environment, no testing library —
 * and adding one is out of scope), so this suite covers the two things that
 * actually matter:
 *  1. the double-submit gate LOGIC (real, executed), and
 *  2. the exact WIRING in the composer: the loading state is bound to the
 *     real server-action promise, both dialog buttons are disabled while it
 *     runs, the state is released in `finally`, and the send engine
 *     (send-action → createCampaign) is untouched.
 */

const COMPOSER = readFileSync(
  "src/components/application-composer.tsx",
  "utf8",
);
const ACTION = readFileSync("src/app/applications/new/send-action.ts", "utf8");
const PACKAGE = readFileSync("package.json", "utf8");

/** The handler body, so assertions cannot accidentally match elsewhere. */
function handler(): string {
  const start = COMPOSER.indexOf("function handleSendSubmit(");
  expect(start).toBeGreaterThan(-1);
  return COMPOSER.slice(start, COMPOSER.indexOf("const applyTemplate"));
}

describe("send gate (one send per operation)", () => {
  it("rejects a second begin while a send is running (double click)", () => {
    const gate = createSendGate();
    expect(gate.begin()).toBe(true);
    expect(gate.inFlight).toBe(true);
    // The second click of a double click is rejected outright.
    expect(gate.begin()).toBe(false);
  });

  it("a double click triggers exactly ONE send", () => {
    const gate = createSendGate();
    let sends = 0;
    const click = () => {
      if (!gate.begin()) return;
      sends += 1;
    };
    click();
    click(); // same tick — the state has not re-rendered yet
    expect(sends).toBe(1);
  });

  it("success releases the gate (loading stops, retry possible)", async () => {
    const gate = createSendGate();
    await (async () => {
      gate.begin();
      try {
        await Promise.resolve("ok");
      } finally {
        gate.end();
      }
    })();
    expect(gate.inFlight).toBe(false);
    expect(gate.begin()).toBe(true);
  });

  it("failure releases the gate too (finally semantics)", async () => {
    const gate = createSendGate();
    let released = false;
    await (async () => {
      gate.begin();
      try {
        throw new Error("send failed");
      } catch {
        // The component deliberately does not catch; the gate must still end.
      } finally {
        gate.end();
        released = true;
      }
    })();
    expect(released).toBe(true);
    expect(gate.inFlight).toBe(false);
  });
});

describe("composer wiring (loading bound to the real promise)", () => {
  it("Continue goes through the real server action inside a transition", () => {
    const body = handler();
    expect(body).toContain("event.preventDefault()");
    expect(body).toContain("new FormData(event.currentTarget)");
    expect(body).toContain("startSend(async () =>");
    expect(body).toContain("await sendApplications(formData)");
    // The loading state is React's, driven by the action's own promise.
    expect(COMPOSER).toContain("const [isSending, startSend] = useTransition()");
    // …and it starts before the first response, not after it.
    expect(body.indexOf("startSend(")).toBeLessThan(
      body.indexOf("await sendApplications"),
    );
  });

  it("releases the gate in `finally` and never swallows the action's errors", () => {
    const body = handler();
    expect(body).toContain("} finally {");
    expect(body).toContain("sendGate.end()");
    // No catch → the redirect on success and the existing error handling
    // keep working exactly as before.
    expect(body).not.toContain("catch");
  });

  it("disables Continue and Review again while sending", () => {
    expect(COMPOSER).toContain('onSubmit={handleSendSubmit}');
    expect(COMPOSER).toContain('action={sendApplications}');
    // Continue
    expect(COMPOSER).toMatch(/disabled=\{isSending\}[\s\S]{0,200}aria-busy=\{isSending\}/);
    // Review again
    expect(COMPOSER).toMatch(
      /onClick=\{\(\) => setConfirmOpen\(false\)\}\s*disabled=\{isSending\}/,
    );
    // The sidebar trigger cannot reopen the dialog mid-send either.
    expect(COMPOSER).toMatch(/isPending \|\|\s*isSending \|\|/);
  });

  it("shows a small inline spinner + the required texts (no overlay, no fake progress)", () => {
    expect(COMPOSER).toContain("Sending applications… Please keep this page open.");
    expect(COMPOSER).toContain('{isSending ? "Sending…" : "Continue"}');
    expect(COMPOSER).toContain("animate-spin");
    // No invented per-item progress (the server action reports none).
    expect(COMPOSER).not.toContain("Sending 1 of");
    expect(COMPOSER).not.toContain("sentCount");
    expect(COMPOSER).not.toContain("progress");
  });

  it("adds no dependency and no new loading library", () => {
    for (const forbidden of ["react-spinners", "nprogress", "react-loading"])
      expect(PACKAGE).not.toContain(forbidden);
  });
});

describe("email sending engine untouched", () => {
  it("the send action still creates the campaign through the same path", () => {
    expect(ACTION).toContain("createCampaign({");
    expect(ACTION).toContain("recipientEmails: recipients");
    expect(ACTION).toContain("redirect(`/applications/campaign/${result.campaignId}`)");
    expect(ACTION).toContain('"use server"');
  });

  it("the composer imports the same action (no re-implementation)", () => {
    expect(COMPOSER).toContain(
      'import { sendApplications } from "@/app/applications/new/send-action"',
    );
    expect(COMPOSER).not.toContain("createCampaign");
  });
});
