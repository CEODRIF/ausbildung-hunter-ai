// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 1 profile photo preview (ProfilePhotoImage) behavior.
 *
 * Context: the photo card showed size + timestamp after a successful
 * upload, but the image itself rendered as a broken-image icon: the
 * same-origin, cookie-authenticated GET answered 404 because the route
 * never resolved the CURRENT-photo row (it only handled frozen ?ref=
 * tokens). Route-level wiring is pinned in
 * tests/auto-bewerb-profile-photo-route.test.ts; this file pins the
 * COMPONENT contract:
 *   1. the img source is the cache-busted preview URL (upload timestamp);
 *   2. a retrieval failure renders the explicit retry state — NEVER the
 *      browser's broken-image icon (no <img> left in the DOM);
 *   3. retry re-requests with a fresh bust parameter;
 *   4. replacing the photo (new upload timestamp = new key) remounts the
 *      component: failure state reset + the NEW timestamp in the src, so
 *      a stale cached image can never be shown.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { ProfilePhotoImage } from "@/components/auto-bewerb/step1-cv";

vi.mock("@/app/auto-bewerb/actions", () => ({
  deleteProfileAction: vi.fn(),
  saveProfileExtractAction: vi.fn(),
}));

function renderPhoto(uploadedAt: string) {
  return render(
    <I18nProvider>
      <ProfilePhotoImage uploadedAt={uploadedAt} alt="Professional Profile Photo" />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("ProfilePhotoImage — Step 1 photo preview", () => {
  it("requests the same-origin preview URL, cache-busted by the upload timestamp", () => {
    renderPhoto("2026-10-30T16:47:00.000Z");
    const img = screen.getByRole("img", { name: "Professional Profile Photo" });
    expect(img).toHaveAttribute(
      "src",
      `/api/auto-bewerb/profile-photo?ts=${encodeURIComponent("2026-10-30T16:47:00.000Z")}`,
    );
    // No stretch: the existing card keeps its object-fit cover box.
    expect(img.className).toContain("object-cover");
  });

  it("a retrieval failure shows the explicit retry state — no broken-image icon", () => {
    renderPhoto("2026-10-30T16:47:00.000Z");
    fireEvent.error(screen.getByRole("img"));
    // The <img> is unmounted (the broken-image icon can no longer appear).
    expect(screen.queryByRole("img")).toBeNull();
    // …and the documented Retry action is available.
    const retry = screen.getByRole("button", { name: "Erneut versuchen" });
    expect(retry).toBeInTheDocument();
  });

  it("retry re-requests with a fresh bust parameter", () => {
    renderPhoto("2026-10-30T16:47:00.000Z");
    fireEvent.error(screen.getByRole("img"));
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    const img = screen.getByRole("img", { name: "Professional Profile Photo" }) as HTMLImageElement;
    expect(img.src).toContain(`ts=${encodeURIComponent("2026-10-30T16:47:00.000Z")}`);
    expect(img.src).toContain("&r=1");
  });

  it("replacing the photo (new key) resets the failure state and shows the NEW timestamp — never a stale cached image", () => {
    const first = renderPhoto("2026-10-30T16:47:00.000Z");
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();

    // A successful replace updates ws.photo.uploadedAt → the card remounts
    // the component with the new key.
    first.rerender(
      <I18nProvider>
        <ProfilePhotoImage key="2026-10-30T18:02:11.000Z" uploadedAt="2026-10-30T18:02:11.000Z" alt="Professional Profile Photo" />
      </I18nProvider>,
    );
    const img = screen.getByRole("img", { name: "Professional Profile Photo" }) as HTMLImageElement;
    expect(img).toHaveAttribute(
      "src",
      `/api/auto-bewerb/profile-photo?ts=${encodeURIComponent("2026-10-30T18:02:11.000Z")}`,
    );
    expect(img.src).not.toContain("16:47");
    expect(img.src).not.toContain("&r=");
  });
});
