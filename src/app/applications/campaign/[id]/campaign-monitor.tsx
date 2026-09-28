"use client";

import { useEffect } from "react";

export function CampaignMonitor() {
  useEffect(() => {
    const timer = window.setInterval(() => window.location.reload(), 10000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="mt-2 text-xs text-[#8290a4]">
      Updates automatically every 10 seconds.
    </p>
  );
}
