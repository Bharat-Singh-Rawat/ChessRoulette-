"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export type WebRTCStatus =
  | "idle"
  | "requesting_camera"
  | "connecting"
  | "connected"
  | "failed_camera"
  | "failed_connection";

type Args = {
  socket: Socket | null;
  gameId: string | null;
  isInitiator: boolean;
  enabled: boolean;
  /** When true, only request local camera; skip peer connection (no remote peer). */
  localOnly?: boolean;
};

export function useWebRTC({ socket, gameId, isInitiator, enabled, localOnly }: Args) {
  const [status, setStatus] = useState<WebRTCStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    if (!enabled || !socket || !gameId) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let pc: RTCPeerConnection | null = null;
    // ICE candidates can arrive before remoteDescription is set; queue them.
    const pendingCandidates: RTCIceCandidateInit[] = [];

    const onOffer = async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        for (const c of pendingCandidates.splice(0)) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("webrtc:answer", { gameId, sdp: answer });
      } catch (e) {
        console.warn("webrtc onOffer error", e);
      }
    };

    const onAnswer = async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        for (const c of pendingCandidates.splice(0)) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
      } catch (e) {
        console.warn("webrtc onAnswer error", e);
      }
    };

    const onIce = async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      if (!pc) return;
      if (!pc.remoteDescription) {
        pendingCandidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("webrtc addIceCandidate failed", e);
      }
    };

    if (!localOnly) {
      socket.on("webrtc:offer", onOffer);
      socket.on("webrtc:answer", onAnswer);
      socket.on("webrtc:ice", onIce);
    }

    (async () => {
      setStatus("requesting_camera");
      setError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (e) {
        if (!cancelled) {
          setStatus("failed_camera");
          setError(
            (e as Error).message ?? "Camera/mic permission denied. Game still works.",
          );
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setLocalStream(stream);

      // localOnly path: no peer to connect to, just show local preview.
      if (localOnly) {
        setStatus("connected");
        return;
      }

      setStatus("connecting");

      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc!.addTrack(t, stream!));

      pc.ontrack = (ev) => {
        const [s] = ev.streams;
        if (s) setRemoteStream(s);
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) socket.emit("webrtc:ice", { gameId, candidate: ev.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        if (pc.connectionState === "connected") setStatus("connected");
        else if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        ) {
          setStatus("failed_connection");
        }
      };

      if (isInitiator) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("webrtc:offer", { gameId, sdp: offer });
        } catch (e) {
          console.warn("webrtc createOffer failed", e);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (!localOnly) {
        socket.off("webrtc:offer", onOffer);
        socket.off("webrtc:answer", onAnswer);
        socket.off("webrtc:ice", onIce);
      }
      pc?.close();
      pcRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
      setRemoteStream(null);
      setStatus("idle");
    };
  }, [enabled, gameId, isInitiator, socket, localOnly]);

  return { status, error, localStream, remoteStream };
}
