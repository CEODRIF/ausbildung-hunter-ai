"use client";

/**
 * Community Phase 4 — the voice UI (rendered by RoomChat under the header).
 *
 * Three mutually exclusive views, all driven by the useVoice hook:
 *   - OUTSIDE, active:      a count-only bar ("Voice conversation · N").
 *                           Strict privacy: NO participant names, avatars,
 *                           or mic states render (or even exist in the DOM)
 *                           before an explicit join.
 *   - OUTSIDE, dialog open: the join dialog (explicit user action; the
 *                           microphone is only touched by the Join flow).
 *   - INSIDE:               participant tiles (SFU-driven), the status pill,
 *                           and the controls (mute / speaker / leave).
 *
 * Accessibility: every control has an accessible label; the speaking
 * indicator is NOT color-only (bars + border + aria label); join/leave use
 * subtle CSS transitions that are disabled under prefers-reduced-motion
 * (and the exit transition is then skipped in JS, so no tile can linger).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { communityAvatarUrl } from "@/lib/community";
import { Icon } from "@/components/icon";
import type { UseVoice, VoiceMeta } from "./use-voice";
import type { VoiceParticipant } from "@/lib/voice/types";

export function VoicePanel({ voice }: { voice: UseVoice }) {
  const { t } = useI18n();

  // Subtle exit transition (event-driven via animationend — no timers).
  // Under prefers-reduced-motion there is no exit animation at all.
  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const [exiting, setExiting] = useState<Record<string, VoiceParticipant>>({});
  const prevParticipantsRef = useRef<VoiceParticipant[]>([]);
  useEffect(() => {
    const prev = prevParticipantsRef.current;
    prevParticipantsRef.current = voice.participants;
    if (reducedMotion) return;
    const current = new Set(voice.participants.map((p) => p.identity));
    const gone = prev.filter((p) => !current.has(p.identity));
    if (gone.length === 0) return;
    setExiting((old) => {
      const next = { ...old };
      for (const p of gone) next[p.identity] = p;
      return next;
    });
  }, [voice.participants, reducedMotion]);
  const finishExit = (identity: string) =>
    setExiting((old) => {
      const next = { ...old };
      delete next[identity];
      return next;
    });

  const visibleTiles = useMemo(() => {
    const list = [...voice.participants];
    for (const [id, p] of Object.entries(exiting)) {
      if (!list.some((x) => x.identity === id)) list.push(p);
    }
    return list;
  }, [voice.participants, exiting]);

  const countLabel = (n: number) =>
    n === 1 ? t("community.voiceParticipantsOne") : t("community.voiceParticipants", { count: n });

  // ------------------------------------------------------------- dialog
  if (voice.dialogOpen) {
    const failed =
      voice.connection === "error" ||
      voice.connection === "mic_denied" ||
      voice.connection === "unavailable";
    // Viewport-level modal: portal to <body> so NO ancestor (transform,
    // backdrop-filter, overflow) can become the `fixed` containing block —
    // the classic iOS mis-anchoring. Centered horizontally AND vertically at
    // every width (the old bottom-docked sheet sat under the floating bottom
    // nav), z-50 above content/header(z-20)/nav(z-30)/drawer(z-40), with the
    // overlay padding honouring iOS safe-area insets (notch, home indicator).
    // The full-viewport backdrop sits ABOVE the bottom nav, so it is dimmed
    // and click-blocked behind the dialog.
    return createPortal(
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{
          padding:
            "max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))",
        }}
      >
        <div
          className="fixed inset-0 bg-ink/40"
          onClick={voice.closeDialog}
          aria-hidden="true"
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="voice-dialog-title"
          className="relative flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-xl"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name="mic" size={17} />
            </span>
            <div className="min-w-0">
              <h2 id="voice-dialog-title" className="text-sm font-bold text-ink">
                {t("community.voiceTitle")}
              </h2>
              {voice.active && (
                <p className="text-xs font-semibold text-muted">{countLabel(voice.count)}</p>
              )}
            </div>
          </div>
          <p className="text-xs leading-5 text-muted">{t("community.voiceJoinDescription")}</p>
          {voice.connection === "unavailable" && (
            <p
              role="alert"
              className="rounded-lg bg-warning-soft px-3 py-2 text-xs font-semibold leading-5 text-warning"
            >
              {t("community.voiceUnavailable")}
            </p>
          )}
          {voice.connection === "error" && (
            <div className="flex flex-col gap-2">
              <p
                role="alert"
                className="rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold leading-5 text-danger"
              >
                {t("community.voiceConnectionError")}
              </p>
              {/* Production-incident diagnostic: the REAL cause (error name +
                  numeric code + redacted message + SFU host) — secret-free by
                  construction; muted and technical. The friendly message
                  above stays the primary text. */}
              {voice.diagnostic ? (
                <p className="break-words rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-4 text-muted">
                  {voice.diagnostic}
                </p>
              ) : null}
            </div>
          )}
          {voice.connection === "mic_denied" && (
            <p
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold leading-5 text-danger"
            >
              {t("community.voiceMicrophoneDenied")}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={voice.closeDialog}
              className="rounded-xl px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {t("community.voiceClose")}
            </button>
            <button
              type="button"
              autoFocus
              disabled={voice.connection === "connecting" || voice.connection === "unavailable"}
              onClick={() =>
                void (failed ? voice.retryConnection() : voice.join())
              }
              className="rounded-xl bg-accent px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {failed ? t("community.voiceTryAgain") : t("community.voiceJoin")}
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // ------------------------------------------------------- outside: bar
  if (!voice.inVoice) {
    if (!voice.active) return null; // no conversation → nothing (step: count 0 = hidden)
    return (
      <button
        type="button"
        onClick={voice.openDialog}
        data-voice-bar
        className="flex w-full shrink-0 items-center border-b border-line bg-accent-soft/40 px-3 py-2 text-start transition-colors hover:bg-accent-soft sm:px-6"
      >
        <span className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <Icon name="mic" size={14} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="text-xs font-bold text-ink">{t("community.voiceTitle")}</span>
          <span className="text-xs text-faint" aria-hidden="true">
            ·
          </span>
          <span className="text-xs font-semibold text-muted">{countLabel(voice.count)}</span>
        </span>
      </button>
    );
  }

  // ------------------------------------------------------------ inside
  const muted = voice.micState !== "on";
  return (
    <div
      data-voice-inside
      className="flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-3 py-2 sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusPill voice={voice} />
          <ul
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
            aria-label={t("community.voiceTitle")}
          >
            {visibleTiles.map((p) => (
              <VoiceTile
                key={p.identity}
                p={p}
                leaving={Boolean(exiting[p.identity])}
                onExit={finishExit}
              />
            ))}
          </ul>
        </div>

        {voice.micState === "denied" && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold text-danger"
          >
            <Icon name="micOff" size={12} aria-hidden="true" />
            <span className="min-w-0 flex-1">{t("community.voiceMicrophoneDenied")}</span>
            <button
              type="button"
              onClick={() => void voice.retryMic()}
              className="rounded-md bg-danger px-2 py-1 font-bold text-white transition-opacity hover:opacity-90"
            >
              {t("community.voiceTryAgain")}
            </button>
          </div>
        )}
        {voice.connection === "error" && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold text-danger"
          >
            <Icon name="alert" size={12} aria-hidden="true" />
            <span className="min-w-0 flex-1">{t("community.voiceConnectionError")}</span>
            <button
              type="button"
              onClick={() => void voice.retryConnection()}
              className="rounded-md bg-danger px-2 py-1 font-bold text-white transition-opacity hover:opacity-90"
            >
              {t("community.voiceTryAgain")}
            </button>
          </div>
        )}

        {/* Controls — the Leave button stays reachable (end of the row). */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void voice.toggleMicrophone()}
            aria-pressed={!muted}
            aria-label={muted ? t("community.voiceUnmute") : t("community.voiceMute")}
            title={muted ? t("community.voiceUnmute") : t("community.voiceMute")}
            className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
              muted ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent"
            }`}
          >
            <Icon name={muted ? "micOff" : "mic"} size={15} />
          </button>
          {voice.speakerSelectionSupported && voice.outputDevices.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs font-semibold text-muted">
              <Icon name="volume" size={14} aria-hidden="true" />
              <span className="sr-only">{t("community.voiceSpeaker")}:</span>
              <select
                value={voice.selectedOutput}
                onChange={(e) => void voice.setOutput(e.target.value)}
                aria-label={t("community.voiceSpeaker")}
                className="max-w-36 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
              >
                <option value="">{t("community.voiceSpeakerDefault")}</option>
                {voice.outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => void voice.leave()}
            className="ms-auto flex items-center gap-1.5 rounded-xl bg-danger px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
          >
            <Icon name="phoneOff" size={13} aria-hidden="true" />
            {t("community.voiceLeave")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Connection status — text + icon (never color alone). */
function StatusPill({ voice }: { voice: UseVoice }) {
  const { t } = useI18n();
  if (voice.connection === "reconnecting") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 py-1 text-[11px] font-semibold text-warning">
        <Icon name="wifi" size={11} aria-hidden="true" />
        {t("community.voiceReconnecting")}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success">
      <Icon name="wifi" size={11} aria-hidden="true" />
      {t("community.voiceConnected")}
    </span>
  );
}

/** One participant tile (the only place identities render — inside voice). */
function VoiceTile({
  p,
  leaving,
  onExit,
}: {
  p: VoiceParticipant;
  leaving: boolean;
  onExit: (identity: string) => void;
}) {
  const { t } = useI18n();
  const name = p.isSelf ? `${p.name} (${t("community.voiceYou")})` : p.name;
  const aria = [
    name,
    p.speaking ? t("community.voiceSpeaking") : null,
    p.muted ? t("community.voiceMute") : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li
      data-voice-tile
      aria-label={aria}
      onAnimationEnd={leaving ? () => onExit(p.identity) : undefined}
      className={`flex items-center gap-1.5 rounded-full border py-1 ps-1 pe-2.5 ${
        leaving ? "voice-tile-exit" : "voice-tile-enter"
      } ${p.speaking ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
    >
      {p.avatarId ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 24px, static public asset
        <img
          src={communityAvatarUrl(p.avatarId)}
          alt=""
          width={24}
          height={24}
          className={`h-6 w-6 shrink-0 rounded-full object-cover ${
            p.speaking ? "ring-2 ring-accent" : ""
          }`}
        />
      ) : (
        <span
          aria-hidden="true"
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-bold text-muted ${
            p.speaking ? "ring-2 ring-accent" : ""
          }`}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="max-w-24 truncate text-xs font-semibold text-ink sm:max-w-40">{name}</span>
      {p.muted ? (
        <Icon name="micOff" size={11} className="shrink-0 text-danger" aria-hidden="true" />
      ) : p.speaking ? (
        <span className="voice-speaking-bars shrink-0 text-accent" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <Icon name="mic" size={11} className="shrink-0 text-success" aria-hidden="true" />
      )}
    </li>
  );
}

/** Re-export for the hook's reporting contract (shell nav indicator). */
export type { VoiceMeta };
