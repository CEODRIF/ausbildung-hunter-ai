"use client";

/**
 * Community Phase 4 — the voice session hook (ONE instance per room mount).
 *
 * This is the bridge between the UI and the SFU (LiveKit WebRTC). It owns:
 *   - the single media session (the `livekit-client` Room is created lazily
 *     on an explicit join — the SDK is dynamic-imported, so it never enters
 *     the room page's initial bundle),
 *   - the join flow (token route → connect → publish microphone),
 *   - participant tracking (SFU events only — NO polling, NO timers),
 *   - the AGGREGATE count coordination: a metadata-only Supabase Realtime
 *     broadcast (count only — never identities) + the durable row via
 *     syncVoiceCount, both only when the observed count CHANGES,
 *   - mute/unmute (UI follows the ACTUAL track state, never faked),
 *   - speaker selection (feature-detected; hidden where unsupported),
 *   - reconnect: LiveKit's own ICE reconnect (Wi-Fi change, sleep, background)
 *     with UI state reconciliation on Reconnected — no duplicate Room, no
 *     duplicate tracks, no duplicate subscriptions, no unbounded retries,
 *   - visibility: a hidden tab does NOT stop the microphone and does NOT
 *     leave the conversation; on return we reconcile state,
 *   - cleanup on unmount (tracks stopped, channel unsubscribed, listeners
 *     removed — no leaks).
 *
 * Audio media flows Browser <-> SFU only. Supabase Realtime carries the
 * integer count + nothing else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { syncVoiceCount } from "@/app/community/voice-actions";
import type {
  VoiceConnectionState,
  VoiceJoinConfig,
  VoiceParticipant,
} from "@/lib/voice/types";

export interface VoiceMeta {
  active: boolean;
  count: number;
}

export type VoiceMicState = "on" | "off" | "denied" | "error";

export interface UseVoiceOptions {
  roomId: string;
  me: { userId: string; displayName: string; avatarId: string };
  initialMeta: VoiceMeta;
  /** Event-driven aggregate report (the shell's nav indicator). */
  onMetaChange?: (meta: VoiceMeta) => void;
}

export interface UseVoice extends VoiceMeta {
  inVoice: boolean;
  connection: VoiceConnectionState;
  micState: VoiceMicState;
  participants: VoiceParticipant[];
  speakerSelectionSupported: boolean;
  outputDevices: Array<{ deviceId: string; label: string }>;
  selectedOutput: string;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** Explicit user action: token → connect → mic. Never called on load. */
  join: () => Promise<void>;
  /** Explicit user action after a permission denial. */
  retryMic: () => Promise<void>;
  /** Explicit user action after a connection failure. */
  retryConnection: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMicrophone: () => Promise<void>;
  setOutput: (deviceId: string) => Promise<void>;
}

type LKRoom = InstanceType<typeof import("livekit-client").Room>;
type LKConnectionState = (typeof import("livekit-client").ConnectionState)[keyof typeof import("livekit-client").ConnectionState];
type LKModule = typeof import("livekit-client");

const MAX_PARTICIPANTS = 50;

export function useVoice(opts: UseVoiceOptions): UseVoice {
  const { roomId, me, initialMeta } = opts;

  const [metaState, setMetaState] = useState<VoiceMeta>(initialMeta);
  const [inVoice, setInVoice] = useState(false);
  const [connection, setConnection] = useState<VoiceConnectionState>("idle");
  const [micState, setMicState] = useState<VoiceMicState>("off");
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [outputDevices, setOutputDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [selectedOutput, setSelectedOutput] = useState("");
  // Programmatic output selection (setSinkId) — feature-detected once; the
  // speaker control is hidden (not disabled) where unsupported.
  const [speakerSelectionSupported] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof navigator.mediaDevices?.enumerateDevices === "function" &&
      "setSinkId" in HTMLMediaElement.prototype,
  );

  const roomRef = useRef<LKRoom | null>(null);
  const lkRef = useRef<LKModule | null>(null);
  const disposedRef = useRef(false);
  const leaveCalledRef = useRef(false);
  const joinLockRef = useRef(false);
  const inVoiceRef = useRef(false);
  const lastCountRef = useRef(0);
  const lastSyncedCountRef = useRef(-1);
  const micStateRef = useRef<VoiceMicState>("off");
  const meRef = useRef(me);
  const onMetaChangeRef = useRef(opts.onMetaChange);
  const countChannelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    meRef.current = me;
    onMetaChangeRef.current = opts.onMetaChange;
  }, [me, opts.onMetaChange]);

  useEffect(() => {
    micStateRef.current = micState;
  }, [micState]);

  // ------------------------------------------------------------------
  // Aggregate count coordination (metadata only — never identities).
  // ------------------------------------------------------------------
  const broadcastCount = useCallback(
    (n: number) => {
      const channel = countChannelRef.current;
      if (channel) {
        channel
          .send({ type: "broadcast", event: "voice", payload: { kind: "count", count: n } })
          .catch(() => {});
      }
    },
    [],
  );

  const publishCount = useCallback(
    (n: number) => {
      const clamped = Math.max(0, Math.min(MAX_PARTICIPANTS, n));
      lastCountRef.current = clamped;
      // Live update for outsiders in the room (count only):
      broadcastCount(clamped);
      // Durable aggregate — only when the observed count CHANGES (a join or
      // a leave, never a heartbeat); the SQL function enforces convergence.
      if (clamped !== lastSyncedCountRef.current) {
        lastSyncedCountRef.current = clamped;
        void syncVoiceCount(roomId, clamped);
      }
    },
    [broadcastCount, roomId],
  );

  // The metadata-only broadcast channel (one per room mount). Outsiders see
  // the live count; participants ignore it (the SFU is their source of truth).
  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    try {
      const supabase = createClient();
      channel = supabase
        .channel(`community-voice-${roomId}`)
        .on("broadcast", { event: "voice" }, ({ payload }: { payload: unknown }) => {
          if (inVoiceRef.current) return; // participants: the SFU is the truth
          const data = payload as { kind?: unknown; count?: unknown } | null;
          if (!data || data.kind !== "count" || typeof data.count !== "number") return;
          const n = Math.max(0, Math.min(MAX_PARTICIPANTS, Math.floor(data.count)));
          setMetaState({ active: n > 0, count: n });
        })
        .subscribe();
      countChannelRef.current = channel;
    } catch {
      /* voice chrome is best-effort; the room must never break */
    }
    return () => {
      const c = countChannelRef.current;
      countChannelRef.current = null;
      if (c) c.unsubscribe().catch(() => {});
      void channel;
    };
  }, [roomId]);

  // Report the aggregate meta (event-driven; the shell renders "Voice · N").
  const effectiveMeta: VoiceMeta = inVoice
    ? { active: true, count: participants.length }
    : metaState;
  useEffect(() => {
    onMetaChangeRef.current?.(effectiveMeta);
  }, [effectiveMeta.active, effectiveMeta.count]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------
  // Participant truth (SFU events only).
  // ------------------------------------------------------------------
  const refreshParticipants = useCallback(
    (room: LKRoom) => {
      const speaking = new Set(room.activeSpeakers.map((s) => s.identity));
      const list: VoiceParticipant[] = [];
      const local = room.localParticipant;
      if (local && local.identity) {
        list.push({
          identity: local.identity,
          name: local.name || meRef.current.displayName || "Member",
          avatarId: meRef.current.avatarId || null,
          muted: !local.isMicrophoneEnabled,
          speaking: speaking.has(local.identity),
          isSelf: true,
        });
        // Track state is the truth: recover a previously denied mic.
        if (local.isMicrophoneEnabled && micStateRef.current === "denied") {
          setMicState("on");
        }
      }
      room.remoteParticipants.forEach((p) => {
        let avatarId: string | null = null;
        if (p.metadata) {
          try {
            const md = JSON.parse(p.metadata) as { avatarId?: unknown };
            if (typeof md.avatarId === "string" && md.avatarId) avatarId = md.avatarId;
          } catch {
            /* malformed metadata — never fatal */
          }
        }
        list.push({
          identity: p.identity,
          name: p.name || "Member",
          avatarId,
          muted: !p.isMicrophoneEnabled,
          speaking: speaking.has(p.identity),
          isSelf: false,
        });
      });
      list.sort((a, b) =>
        a.isSelf === b.isSelf ? a.name.localeCompare(b.name) : a.isSelf ? -1 : 1,
      );
      setParticipants(list);
      publishCount(list.length);
    },
    [publishCount],
  );

  const refreshOutputDevices = useCallback(() => {
    if (!speakerSelectionSupported) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (disposedRef.current) return;
        setOutputDevices(
          devices
            .filter((d) => d.kind === "audiooutput")
            .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId })),
        );
      })
      .catch(() => {});
  }, [speakerSelectionSupported]);

  const cleanupRoom = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    lkRef.current = null;
    if (room) {
      room.disconnect().catch(() => {});
    }
  }, []);

  const wireRoomEvents = useCallback(
    (room: LKRoom, lk: LKModule) => {
      room.on(lk.RoomEvent.ConnectionStateChanged, (state: LKConnectionState) => {
        if (disposedRef.current) return;
        if (state === "reconnecting" || state === "signalReconnecting") {
          setConnection("reconnecting");
        } else if (state === "connected") {
          setConnection("connected");
        }
      });
      room.on(lk.RoomEvent.Reconnected, () => {
        if (disposedRef.current) return;
        // LiveKit re-established the media+signal paths (Wi-Fi change,
        // sleep, backgrounding). Reconcile — no duplicate tracks: the SAME
        // Room instance keeps its single publish.
        setConnection("connected");
        refreshParticipants(room);
      });
      room.on(lk.RoomEvent.Disconnected, () => {
        if (disposedRef.current || leaveCalledRef.current) return;
        // Unrecoverable (or the SFU dropped us — e.g. duplicate identity):
        setConnection("error");
        setDialogOpen(true);
        inVoiceRef.current = false;
        setInVoice(false);
        setParticipants([]);
        setMicState("off");
        cleanupRoom();
      });
      room.on(lk.RoomEvent.ParticipantConnected, () => refreshParticipants(room));
      room.on(lk.RoomEvent.ParticipantDisconnected, () => refreshParticipants(room));
      room.on(lk.RoomEvent.ActiveSpeakersChanged, () => refreshParticipants(room));
      room.on(lk.RoomEvent.TrackMuted, () => refreshParticipants(room));
      room.on(lk.RoomEvent.TrackUnmuted, () => refreshParticipants(room));
      room.on(lk.RoomEvent.ParticipantNameChanged, () => refreshParticipants(room));
      room.on(lk.RoomEvent.MediaDevicesChanged, () => refreshOutputDevices());
      room.on(lk.RoomEvent.MediaDevicesError, () => {
        const current = roomRef.current;
        if (current && !current.localParticipant.isMicrophoneEnabled) {
          setMicState("error");
        }
      });
    },
    [cleanupRoom, refreshOutputDevices, refreshParticipants],
  );

  // ------------------------------------------------------------------
  // Join (explicit user action only — never on page load / community open).
  // ------------------------------------------------------------------
  const connectToSfu = useCallback(
    async (config: VoiceJoinConfig) => {
      if (roomRef.current) return; // never a second media session
      const lk = (await import("livekit-client")) as LKModule;
      lkRef.current = lk;
      const room = new lk.Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      wireRoomEvents(room, lk);
      try {
        await room.connect(config.url, config.token, { autoSubscribe: true });
      } catch (error) {
        roomRef.current = null;
        lkRef.current = null;
        room.disconnect().catch(() => {});
        throw error;
      }
      // The microphone is published EXPLICITLY after the connection (this is
      // where the browser asks for permission — inside the join gesture
      // chain, never on load). A denial does NOT break the session: the user
      // keeps listening and can retry the mic explicitly.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicState("on");
      } catch {
        setMicState("denied");
      }
      refreshOutputDevices();
    },
    [refreshOutputDevices, wireRoomEvents],
  );

  const join = useCallback(async () => {
    if (joinLockRef.current || inVoiceRef.current || disposedRef.current) return;
    joinLockRef.current = true;
    setDialogOpen(true);
    setConnection("connecting");
    try {
      const res = await fetch("/api/community/voice/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      });
      if (disposedRef.current) return;
      if (res.status === 503) {
        setConnection("unavailable");
        return;
      }
      if (!res.ok) {
        setConnection("error");
        return;
      }
      const config = (await res.json()) as VoiceJoinConfig;
      if (disposedRef.current) return;
      leaveCalledRef.current = false;
      inVoiceRef.current = true;
      setInVoice(true);
      await connectToSfu(config);
      if (disposedRef.current) return;
      setConnection("connected");
      setDialogOpen(false);
      const room = roomRef.current;
      if (room) refreshParticipants(room);
    } catch (error) {
      if (disposedRef.current) return;
      const name = error instanceof Error ? error.name : "";
      const isPermission =
        name === "NotAllowedError" || name === "PermissionDeniedError" || /notallowed|permission/i.test(String(error));
      if (isPermission) {
        // Clear, localized, no auto-retry — an explicit "Try again" is offered.
        setConnection("mic_denied");
      } else {
        setConnection("error");
      }
      cleanupRoom();
    } finally {
      joinLockRef.current = false;
    }
  }, [cleanupRoom, connectToSfu, refreshParticipants, roomId]);

  const retryMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) {
      // No session (permission denied during the join chain) → full re-join
      // on explicit user action.
      setDialogOpen(true);
      await join();
      return;
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      setMicState("on");
    } catch {
      setMicState("denied");
    }
  }, [join]);

  const retryConnection = useCallback(async () => {
    // A fresh token (the old one may be expired) — explicit user action.
    setDialogOpen(true);
    await join();
  }, [join]);

  // ------------------------------------------------------------------
  // Leave (stop tracks, unpublish, disconnect, clean up, reconcile count).
  // ------------------------------------------------------------------
  const leave = useCallback(async () => {
    leaveCalledRef.current = true;
    const after = Math.max(lastCountRef.current - 1, 0);
    broadcastCount(after);
    if (after !== lastSyncedCountRef.current) {
      lastSyncedCountRef.current = after;
      void syncVoiceCount(roomId, after);
    }
    const room = roomRef.current;
    roomRef.current = null;
    lkRef.current = null;
    if (room) {
      // disconnect() stops all local tracks + unpublishes + closes the
      // PeerConnection (no leaked media, no duplicate session on rejoin).
      await room.disconnect().catch(() => {});
    }
    inVoiceRef.current = false;
    setInVoice(false);
    setParticipants([]);
    setConnection("idle");
    setMicState("off");
    setDialogOpen(false);
  }, [broadcastCount, roomId]);

  const toggleMicrophone = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !room.localParticipant.isMicrophoneEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      // UI follows the ACTUAL track state (verified, not assumed):
      setMicState(room.localParticipant.isMicrophoneEnabled ? "on" : "off");
    } catch {
      setMicState("denied");
    }
  }, []);

  const setOutput = useCallback(
    async (deviceId: string) => {
      const room = roomRef.current;
      if (!room) return;
      try {
        const ok = await room.switchActiveDevice("audiooutput", deviceId);
        if (ok) setSelectedOutput(deviceId);
        // Unsupported browser → the call resolves false and the control
        // simply does nothing (it is hidden where unsupported anyway).
      } catch {
        /* graceful no-op */
      }
    },
    [],
  );

  // Dialog: Esc closes (the join action itself stays explicit).
  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDialogOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen]);

  // Visibility: hidden tabs keep the session AND the microphone (no auto
  // leave, no unnecessary stop); on return we reconcile connection state —
  // LiveKit keeps reconnecting in the background meanwhile.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const room = roomRef.current;
      if (!room) return;
      // Reconcile on return (LiveKit kept reconnecting in the background;
      // the ConnectionStateChanged/Reconnected events already drive the UI —
      // this just guarantees fresh participant data the moment we're back).
      refreshParticipants(room);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshParticipants]);

  // Hard cleanup on unmount: no timers to clear (there are none), just the
  // media session + the broadcast channel (its own effect) + listeners.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      leaveCalledRef.current = true;
      const room = roomRef.current;
      roomRef.current = null;
      if (room) {
        room.disconnect().catch(() => {});
      }
    };
  }, []);

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  return {
    ...effectiveMeta,
    inVoice,
    connection,
    micState,
    participants,
    speakerSelectionSupported,
    outputDevices,
    selectedOutput,
    dialogOpen,
    openDialog,
    closeDialog,
    join,
    retryMic,
    retryConnection,
    leave,
    toggleMicrophone,
    setOutput,
  };
}
