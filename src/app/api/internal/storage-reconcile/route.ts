import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DEFAULT_MAX_DELETES,
  MAX_MAX_DELETES,
  reconcileStorage,
} from "@/lib/storage-reconcile";

/**
 * Phase 17 — scheduled storage orphan reconciliation (janitor).
 *
 * Same trust boundary as the email worker endpoints: the
 * `x-email-worker-secret` header (worker == service-level trust). The body is
 * strict and the default is a **dry run** — deletion only happens when the
 * poller explicitly opts in with `execute: true`, and even then it is bounded
 * by the server-clamped `maxDeletes` (≤ 100). Any internal failure returns a
 * generic 500 — no error details, no storage paths beyond the report.
 */
const reconcileBody = z
  .object({
    /** Default false — report only. True actually deletes (bounded). */
    execute: z.boolean().optional(),
    /** Per-tick deletion budget (server-clamped to 1..MAX_MAX_DELETES). */
    maxDeletes: z.number().int().min(1).max(MAX_MAX_DELETES).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const configuredSecret = process.env.EMAIL_WORKER_SECRET;
  const suppliedSecret = request.headers.get("x-email-worker-secret");
  if (!configuredSecret || suppliedSecret !== configuredSecret)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = reconcileBody.safeParse(body ?? {});
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid reconcile request" },
      { status: 400 },
    );

  try {
    const report = await reconcileStorage({
      execute: parsed.data.execute === true,
      maxDeletes: parsed.data.maxDeletes ?? DEFAULT_MAX_DELETES,
    });
    return NextResponse.json(report);
  } catch {
    return NextResponse.json(
      { error: "Reconciliation failed" },
      { status: 500 },
    );
  }
}
