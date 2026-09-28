"use client";

import { useState } from "react";
import { logout } from "@/app/login/actions";
import type { Profile } from "@/lib/auth";
function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

export function ProfileMenu({ profile }: { profile: Profile }) {
  const [open, setOpen] = useState(false);
  const initials = profile.full_name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 rounded-xl p-1.5 pr-2 text-left hover:bg-[#f5f7fa]"
        aria-label="Open account menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#10203b] text-[11px] font-bold text-white">
          {initials}
        </span>
        <span className="hidden max-w-32 truncate text-xs font-semibold text-[#1d3458] sm:block">
          {profile.full_name}
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 w-56 rounded-2xl border border-[#e4eaf2] bg-white p-2 shadow-[0_14px_35px_rgba(16,32,59,0.12)]">
          <div className="border-b border-[#edf0f4] px-3 py-2">
            <p className="truncate text-xs font-bold text-[#1d3458]">
              {profile.full_name}
            </p>
            <p className="mt-1 truncate text-[11px] text-[#8b9ab0]">
              {profile.email}
            </p>
          </div>
          <form action={logout} className="mt-1">
            <button
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-[#d9535d] hover:bg-[#fff5f5]"
              type="submit"
            >
              <span>↪</span> Log out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
