"use client";

import { useEffect, useState } from "react";

export type NSFWStatus =
  | "off"
  | "loading_model"
  | "watching"
  | "flagged"
  | "model_failed";

const SAMPLE_INTERVAL_MS = 3000;
const FLAG_THRESHOLD = 0.7;
const CONSECUTIVE_FLAGS_TO_TRIP = 2;

type Args = {
  videoEl: HTMLVideoElement | null;
  enabled: boolean;
  onFlag?: () => void; // fired once when content is flagged
};

/**
 * Lightweight NSFW guard for a remote video element. Loads nsfwjs lazily on
 * first use; samples a frame every few seconds; trips after several
 * consecutive flagged frames so a single false positive doesn't blank the
 * stream.
 */
export function useNSFWGuard({ videoEl, enabled, onFlag }: Args) {
  const [status, setStatus] = useState<NSFWStatus>("off");

  useEffect(() => {
    if (!enabled || !videoEl) {
      setStatus("off");
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let model: { classify: (img: HTMLCanvasElement) => Promise<{ className: string; probability: number }[]> } | null = null;
    let consecutive = 0;
    let tripped = false;

    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 224;
    const ctx = canvas.getContext("2d");

    async function loadModel() {
      setStatus("loading_model");
      try {
        // Lazy import — keeps tfjs out of the main bundle.
        await import("@tensorflow/tfjs");
        const nsfwjs = await import("nsfwjs");
        const m = await nsfwjs.load();
        if (cancelled) return;
        model = m as unknown as typeof model;
        setStatus("watching");
        scheduleNext();
      } catch (e) {
        console.warn("[nsfw-guard] model load failed", e);
        if (!cancelled) setStatus("model_failed");
      }
    }

    function scheduleNext() {
      if (cancelled || tripped) return;
      timer = setTimeout(scan, SAMPLE_INTERVAL_MS);
    }

    async function scan() {
      if (cancelled || tripped || !model || !videoEl || !ctx) return;
      // Skip if video isn't actually playing yet.
      if (videoEl.readyState < 2 || videoEl.videoWidth === 0) {
        scheduleNext();
        return;
      }
      try {
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const preds = await model.classify(canvas);
        const bad = preds
          .filter((p) => p.className === "Porn" || p.className === "Hentai" || p.className === "Sexy")
          .reduce((acc, p) => acc + p.probability, 0);
        if (bad >= FLAG_THRESHOLD) {
          consecutive += 1;
          if (consecutive >= CONSECUTIVE_FLAGS_TO_TRIP) {
            tripped = true;
            setStatus("flagged");
            onFlag?.();
            return;
          }
        } else {
          consecutive = 0;
        }
      } catch (e) {
        console.warn("[nsfw-guard] classify error", e);
      }
      scheduleNext();
    }

    void loadModel();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // onFlag is intentionally excluded from deps — we only want this to set up
    // once per (videoEl, enabled) change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl, enabled]);

  return { status };
}
