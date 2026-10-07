/**
 * Community Phase 3 — the notification chime (tiny WebAudio blip).
 *
 * Browser autoplay rules are respected: the context is created lazily and
 * only played after the FIRST user interaction (pointerdown/keydown) in
 * this page load, and only when the document has focus. Everything here is
 * best-effort — a blocked or unavailable audio context is silently ignored.
 */

let hasInteracted = false;
let audioContext: AudioContext | null = null;

if (typeof window !== "undefined") {
  const arm = () => {
    hasInteracted = true;
  };
  window.addEventListener("pointerdown", arm, { passive: true, once: false });
  window.addEventListener("keydown", arm, { passive: true });
}

export function playNotificationChime(): void {
  try {
    if (typeof window === "undefined") return;
    if (!hasInteracted) return; // no autoplay before a user gesture
    if (document.visibilityState !== "visible") return;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!audioContext) audioContext = new AC();
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => {});
      return;
    }
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch {
    /* audio is chrome — never throw */
  }
}
