/**
 * Plays the agent's audio track: the room gives a `MediaStreamTrack`, and nothing plays until an
 * element is attached. The same element makes the track readable by an `AnalyserNode`
 * (Chrome gives WebAudio silence for a remote track nothing else is playing). Returns the stop.
 */
export function playTrack(track: MediaStreamTrack): () => void {
  if (typeof Audio === "undefined") return () => {};
  const el = new Audio();
  el.srcObject = new MediaStream([track]);
  el.play().catch((e: unknown) => console.warn("[agentAudio] cannot play the agent's audio", e));
  return () => {
    el.pause();
    el.srcObject = null;
  };
}
