import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n";
import { ProfileIdentityForm } from "@/components/profile-identity-form";
import { PROFILE_AVATAR_IDS } from "@/lib/profile-avatars";

/**
 * UI render tests for the profile identity form (node environment, no
 * DOM): renderToString proves the ACTUAL markup the browser hydrates —
 * all 10 avatars selectable, exactly one selected state, visible
 * preview, name-only fallback while the avatar migration is pending.
 *
 * The action module is imported by the form; its Supabase clients are
 * mocked (the action is only invoked on submit, never during render).
 */

const H = vi.hoisted(() => ({
  store: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string | symbol, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop !== "string") return undefined;
            if (prop === "then") {
              return (resolve: (v: unknown) => void) =>
                Promise.resolve().then(() =>
                  resolve({
                    data: H.store[table] ?? [],
                    error: null,
                  }),
                );
            }
            if (
              prop === "select" ||
              prop === "update" ||
              prop === "eq" ||
              prop === "limit"
            )
              return () => chain;
            return undefined;
          },
        },
      );
      return chain;
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

beforeEach(() => {
  H.store = {};
});

const render = (children: ReactNode): string =>
  renderToString(<I18nProvider>{children}</I18nProvider>);

const gridImgs = (html: string): string[] =>
  html.match(/src="\/profile-avatars\/avatar-\d\d\.svg"/g) ?? [];

/* ================================================================== *
 * avatarEnabled = true (post-migration): the full gallery
 * ================================================================== */

describe("ProfileIdentityForm render — avatar gallery enabled", () => {
  it("renders all 10 local avatars as selectable buttons", () => {
    const html = render(
      <ProfileIdentityForm
        initialName="Mustapha drif"
        initialAvatar="avatar-03"
        avatarEnabled
      />,
    );

    // All 10 asset paths present (grid); the selected one also appears in
    // the live preview → its path occurs twice.
    const imgs = gridImgs(html);
    PROFILE_AVATAR_IDS.forEach((id) => {
      expect(imgs.filter((s) => s.includes(id))).toHaveLength(
        id === "avatar-03" ? 2 : 1,
      );
    });
    expect(imgs).toHaveLength(11); // 10 grid + 1 preview

    // Every grid button is keyboard/touch accessible with a stable label.
    PROFILE_AVATAR_IDS.forEach((id) => {
      const label = dictionaries.de.profile.page.edit.avatars[id];
      expect(html).toContain(`aria-label="${label}"`);
    });

    // Exactly ONE selected state — and it is the persisted avatar
    // (aria-pressed sits directly before the button's aria-label in SSR).
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(9);
    const selectedLabel =
      dictionaries.de.profile.page.edit.avatars["avatar-03"];
    const pressedAt = html.indexOf(
      `aria-pressed="true" aria-label="${selectedLabel}"`,
    );
    expect(pressedAt).toBeGreaterThan(0);
    const selectedBtn = html.slice(pressedAt, pressedAt + 600);

    // Selected state is conveyed beyond color: accent border + a visible
    // check badge (badge wrapper span + its decorative Icon = 2
    // aria-hidden nodes in the whole document).
    expect(selectedBtn).toContain("border-accent");
    expect(selectedBtn).toContain("aria-hidden=\"true\"");
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it("shows the initial name prefilled and the preview for the selected avatar", () => {
    const html = render(
      <ProfileIdentityForm
        initialName="Mustapha drif"
        initialAvatar="avatar-03"
        avatarEnabled
      />,
    );
    expect(html).toContain('id="profile-full-name"');
    expect(html).toContain('value="Mustapha drif"');
    // Live preview uses the selected gallery asset (second occurrence:
    // grid first, preview second).
    const preview = html.slice(html.indexOf("profile-full-name"));
    expect(html.slice(0, html.indexOf("profile-full-name"))).toContain(
      'src="/profile-avatars/avatar-03.svg"',
    );
    expect(preview).toContain('aria-pressed');
  });

  it("no selected avatar → 10 options, none pressed, initials preview", () => {
    const html = render(
      <ProfileIdentityForm
        initialName="Mustapha drif"
        initialAvatar={null}
        avatarEnabled
      />,
    );
    expect(gridImgs(html)).toHaveLength(10);
    expect(html.match(/aria-pressed="true"/g)).toBeNull();
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(10);
    // Initials fallback in the preview: "Mustapha drif" → "MD"
    expect(html).toContain(">MD<");
  });

  it("offers save/cancel with the translated action labels", () => {
    const html = render(
      <ProfileIdentityForm
        initialName="Mustapha drif"
        initialAvatar={null}
        avatarEnabled
      />,
    );
    expect(html).toContain(dictionaries.de.profile.page.edit.save);
    expect(html).toContain(dictionaries.de.profile.page.edit.cancel);
    // Unchanged form → the actions are inert until a real change exists.
    expect(html).toContain('disabled');
  });
});

/* ================================================================== *
 * avatarEnabled = false (pre-migration): honest name-only fallback
 * ================================================================== */

describe("ProfileIdentityForm render — avatar gallery disabled", () => {
  it("renders the name editor but NO avatar grid (the probe-gated state)", () => {
    const html = render(
      <ProfileIdentityForm
        initialName="Mustapha drif"
        initialAvatar={null}
        avatarEnabled={false}
      />,
    );
    expect(gridImgs(html)).toHaveLength(0);
    expect(html.match(/aria-pressed/g)).toBeNull();
    // The gallery label and options are absent entirely.
    expect(html).not.toContain(dictionaries.de.profile.page.edit.chooseAvatar);
    // Name editing is fully preserved.
    expect(html).toContain('id="profile-full-name"');
    expect(html).toContain('value="Mustapha drif"');
    expect(html).toContain(dictionaries.de.profile.page.edit.save);
  });
});
