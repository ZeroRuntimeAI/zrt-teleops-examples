"use client";
/**
 * The live 3D stage: the scene posed from the worker's `poses`, framed into the part of the screen
 * the chrome leaves clear. The `front` and `wrist_cam` cameras render at 30 fps into 640×480
 * render targets; the front one is copied to `frontCanvas`, which the room publishes as the webcam.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { CAMERA_SIZE, loadStageModel, type StageModel } from "./stageModel";
import { STAGE_BACKDROP } from "./ui";

/** Close to the app background, so geometry past the table fades into it. Also the cameras' background. */
const FOG = "#17181b";
const CAMERA_FPS = 30;
const FOV = 30;
const LG = 1024;
type Vec3 = [number, number, number];
/** three.js coordinates (y up): MuJoCo (x, y, z) is (x, z, -y) here. `hero` is the home page's lower, closer view. */
const FRAMES = {
  workspace: { target: [0.18, 0.05, -0.03] as Vec3, from: [0.62, 0.46, 0.5] as Vec3, radius: 0.36 },
  hero: { target: [0.18, 0.05, -0.02] as Vec3, from: [0.66, 0.36, 0.5] as Vec3, radius: 0.3 },
};
type Framing = keyof typeof FRAMES;

/** Pixels of chrome over the stage's right and bottom edges, on large (>= 1024 px) and small screens. */
export type Clear = { lg: [number, number]; sm: [number, number] };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fit a sphere around the workspace, then center it in the part of the stage the chrome leaves clear. */
function Frame({ clear, framing }: { clear: Clear; framing: Framing }) {
  const FRAME = FRAMES[framing];
  const camera = useThree((s) => s.camera);
  const { width, height } = useThree((s) => s.size);
  const [right, bottom] = width >= LG ? clear.lg : clear.sm;
  const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const halfClear = Math.min(Math.atan((tanV * (height - bottom)) / height), Math.atan((tanV * (width - right)) / height));
  const distance = FRAME.radius / Math.sin(halfClear);
  useLayoutEffect(() => {
    const t = new THREE.Vector3(...FRAME.target);
    camera.position.copy(t).addScaledVector(new THREE.Vector3(...FRAME.from).sub(t).normalize(), distance);
    camera.lookAt(t);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.setViewOffset(width, height, right / 2, bottom / 2, width, height);
      camera.updateProjectionMatrix();
    }
  }, [camera, distance, width, height, right, bottom, FRAME]);
  // Past the table, everything sinks into the chrome; scaled with distance so narrow screens stay lit.
  return <fog attach="fog" args={[FOG, distance + 0.35, distance + 1.5]} />;
}

const newTarget = () => {
  const rt = new THREE.WebGLRenderTarget(CAMERA_SIZE.width, CAMERA_SIZE.height, { samples: 4 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  return rt;
};

/** Copy a bottom-up RGBA readback into `canvas`, top-down. */
function paint(canvas: HTMLCanvasElement, pixels: Uint8Array, image: ImageData): void {
  const row = 4 * CAMERA_SIZE.width;
  for (let y = 0; y < CAMERA_SIZE.height; y += 1) {
    image.data.set(pixels.subarray((CAMERA_SIZE.height - 1 - y) * row, (CAMERA_SIZE.height - y) * row), y * row);
  }
  canvas.getContext("2d")?.putImageData(image, 0, 0);
}

/** Poses every frame; the two robot cameras at 30 fps (unless `cameras` is off), before the main view renders. */
function Rig({
  model,
  poses,
  frontCanvas,
  cameras,
}: {
  model: StageModel;
  poses: RefObject<Float64Array | null>;
  frontCanvas: HTMLCanvasElement | null;
  cameras: boolean;
}) {
  const targets = useMemo(() => ({ front: newTarget(), wrist: newTarget() }), []);
  const buffer = useMemo(() => ({ pixels: new Uint8Array(4 * CAMERA_SIZE.width * CAMERA_SIZE.height), image: new ImageData(CAMERA_SIZE.width, CAMERA_SIZE.height) }), []);
  const applied = useRef<Float64Array | null>(null);
  const lastShot = useRef(-Infinity);
  const reading = useRef(false);
  const clearColor = useMemo(() => new THREE.Color(), []);
  useEffect(
    () => () => {
      targets.front.dispose();
      targets.wrist.dispose();
    },
    [targets],
  );

  useFrame(({ gl, scene, clock }) => {
    const p = poses.current;
    if (p && p !== applied.current) {
      applied.current = p;
      model.applyPoses(p);
    }
    // One shadow pass per frame, shared by every render below (the main view renders after this).
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    if (!cameras || clock.elapsedTime - lastShot.current < 1 / CAMERA_FPS) return;
    lastShot.current = clock.elapsedTime;

    gl.getClearColor(clearColor);
    const alpha = gl.getClearAlpha();
    gl.setClearColor(FOG, 1);
    gl.setRenderTarget(targets.front);
    gl.render(scene, model.cameras.front);
    gl.setRenderTarget(targets.wrist);
    gl.render(scene, model.cameras.wrist_cam);
    gl.setRenderTarget(null);
    gl.setClearColor(clearColor, alpha);

    if (!frontCanvas || reading.current) return;
    reading.current = true;
    gl.readRenderTargetPixelsAsync(targets.front, 0, 0, CAMERA_SIZE.width, CAMERA_SIZE.height, buffer.pixels)
      .then(() => paint(frontCanvas, buffer.pixels, buffer.image))
      .catch(() => {}) // A lost context drops a frame; the next one retries.
      .finally(() => {
        reading.current = false;
      });
  });

  return <primitive object={model.root} dispose={null} />;
}

export function Stage({
  files,
  seed,
  poses,
  frontCanvas,
  clear,
  preview = false,
  onError,
}: {
  files: Record<string, Uint8Array> | null;
  seed: number | null;
  poses: RefObject<Float64Array | null>;
  frontCanvas: HTMLCanvasElement | null;
  clear: Clear;
  /** The home page's still: hero framing, and no robot cameras rendering. */
  preview?: boolean;
  /** The stage couldn't load. Without it the failure is a line of text on the backdrop. */
  onError?: (message: string) => void;
}) {
  const [model, setModel] = useState<StageModel | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [spotTarget] = useState(() => new THREE.Object3D());

  useEffect(() => {
    if (!files) return;
    let live = true;
    let built: StageModel | null = null;
    loadStageModel(files).then(
      (m) => {
        if (!live) return m.dispose();
        built = m;
        setModel(m);
      },
      (e: unknown) => {
        if (!live) return;
        if (onError) onError(errorText(e));
        else setFailure(errorText(e));
      },
    );
    return () => {
      live = false;
      built?.dispose();
    };
  }, [files, onError]);

  useEffect(() => {
    if (model && seed !== null) model.reseed(seed);
  }, [model, seed]);

  return (
    <div className={`absolute inset-0 ${STAGE_BACKDROP}`} data-stage="" data-stage-ready={model ? "" : undefined}>
      {failure ? (
        <p className="absolute inset-x-0 bottom-4 text-center font-mono text-micro text-muted">{failure}</p>
      ) : (
        model && (
          <Canvas shadows="percentage" dpr={[1, 2]} gl={{ alpha: true, antialias: true }} camera={{ fov: FOV, near: 0.01, far: 10 }} aria-hidden>
            <Frame clear={clear} framing={preview ? "hero" : "workspace"} />
            <hemisphereLight args={["#fff6ea", "#2b2620", 0.45]} />
            {/* The key light: a soft pool on the workspace, so the table falls off toward its edges. */}
            <primitive object={spotTarget} position={[0.17, 0, -0.04]} />
            <spotLight
              target={spotTarget}
              position={[0.55, 1.5, 0.45]}
              angle={0.3}
              penumbra={0.85}
              decay={0}
              intensity={3.2}
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0004}
              shadow-normalBias={0.002}
              shadow-camera-near={0.5}
              shadow-camera-far={4}
            />
            <directionalLight position={[-0.8, 0.6, -0.6]} intensity={0.35} color="#dfe9ff" />
            <Rig model={model} poses={poses} frontCanvas={frontCanvas} cameras={!preview} />
          </Canvas>
        )
      )}
    </div>
  );
}
