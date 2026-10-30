"use client";
/** The home page's preview: the real scene (the vendored MJCF and meshes) rendered live in WebGL, not a picture of it. */
import dynamic from "next/dynamic";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchFiles, hasWebGL2 } from "./useRobot";

// three.js and MuJoCo load after the page is up, in their own chunk.
const Stage = dynamic(() => import("./Stage").then((m) => m.Stage), { ssr: false });

/** A layout with every cube on the table, the arm folded behind them. */
const PREVIEW_SEED = 7;
const NO_CHROME = { lg: [0, 0], sm: [0, 0] } as { lg: [number, number]; sm: [number, number] };

const Fallback = () => (
  <p className="absolute inset-x-0 bottom-4 text-center font-mono text-micro text-muted">The preview couldn&apos;t load the scene.</p>
);

/** Any render error in the preview (such as the renderer failing to start) costs the preview, never the page. */
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}

function LivePreview({ files }: { files: readonly string[] }) {
  const [loaded, setLoaded] = useState<Record<string, Uint8Array> | null>(null);
  const [failed, setFailed] = useState(false);
  const poses = useRef<Float64Array | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    // No WebGL2: the stage could never start, so don't download it either.
    if (!hasWebGL2()) {
      const id = setTimeout(() => setFailed(true), 0);
      return () => clearTimeout(id);
    }
    fetchFiles(files, abort.signal).then(setLoaded, () => !abort.signal.aborted && setFailed(true));
    return () => abort.abort();
  }, [files]);
  if (failed) return <Fallback />;
  return <Stage files={loaded} seed={PREVIEW_SEED} poses={poses} frontCanvas={null} clear={NO_CHROME} preview />;
}

export function Preview({ files }: { files: readonly string[] }) {
  return (
    <PreviewBoundary>
      <LivePreview files={files} />
    </PreviewBoundary>
  );
}
