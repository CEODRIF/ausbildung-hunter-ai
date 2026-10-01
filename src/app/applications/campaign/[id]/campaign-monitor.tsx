"use client";

import { useEffect, useTransition } from "react";
import { drainCampaign } from "./actions";

/**
 * Campaign monitor.
 *
 * Every tick it asks the server for ONE bounded batch (the same idempotent
 * engine the worker uses) and then re-renders from the database, so the
 * numbers below are always real. Draining is what makes sending actually
 * happen automatically; the reload only reflects the result.
 */
export function CampaignMonitor({ campaignId }: { campaignId: string }) {
  const [isDraining, startDraining] = useTransition();

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      startDraining(async () => {
        try {
          await drainCampaign(campaignId);
        } finally {
          if (!cancelled) window.location.reload();
        }
      });
    };
    const timer = window.setInterval(tick, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [campaignId]);

  return (
    <p className="mt-2 text-xs text-muted">
      {isDraining
        ? "Sending the next batch…"
        : "Updates automatically every 10 seconds."}
    </p>
  );
}
