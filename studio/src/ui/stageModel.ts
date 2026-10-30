/**
 * three.js objects for the scene: one group per MuJoCo body, posed from the worker's `poses`, with
 * the visual geoms and the `front` and `wrist_cam` cameras mounted in body frames.
 *
 * The geometry comes from a main-thread copy of the compiled model (MuJoCo re-centres mesh frames
 * when it compiles, so raw STLs would sit wrong). It never steps physics: that is the worker's.
 * ponytail: the page loads MuJoCo twice (worker + here); have the worker post the geometry once if
 * the second wasm instance ever matters.
 */
import type { MainModule, MjModel } from "@mujoco/mujoco";
import * as THREE from "three";
import type { Scene } from "../sim/scene";

/** so101.xml puts visual meshes in group 2 and collision geoms in groups 3 and 4. */
const MAX_VISUAL_GROUP = 2;
/** World geoms bigger than this are the room's floor and walls; the dark chrome replaces the room. */
const ROOM_HALF_SIZE = 0.5;
export const CAMERA_SIZE = { width: 640, height: 480 } as const;
const CAMERA_NAMES = ["front", "wrist_cam"] as const;
type CameraName = (typeof CAMERA_NAMES)[number];

export type StageModel = {
  root: THREE.Group;
  cameras: Record<CameraName, THREE.PerspectiveCamera>;
  /** Lay out the main-thread copy with the worker's seed: the front camera's mount moves with it. */
  reseed(seed: number): void;
  /** Apply a worker `poses` array (7 per body: x y z qw qx qy qz). */
  applyPoses(poses: Float64Array): void;
  dispose(): void;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadStageModel(files: Record<string, Uint8Array>): Promise<StageModel> {
  const [{ default: loadMujoco }, { Scene }] = await Promise.all([import("@mujoco/mujoco"), import("../sim/scene")]);
  const mj = await loadMujoco();
  try {
    return buildStageModel(mj, Scene.load(mj, files));
  } catch (e) {
    throw new Error(`Couldn't build the 3D stage: ${errorText(e)}`);
  }
}

function meshGeometry(model: MjModel, id: number): THREE.BufferGeometry {
  const va = (model.mesh_vertadr as Int32Array)[id];
  const vn = (model.mesh_vertnum as Int32Array)[id];
  const fa = (model.mesh_faceadr as Int32Array)[id];
  const fn = (model.mesh_facenum as Int32Array)[id];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute((model.mesh_vert as Float32Array).slice(3 * va, 3 * (va + vn)), 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from((model.mesh_face as Int32Array).subarray(3 * fa, 3 * (fa + fn))), 1));
  // Flat shading: the decimated CAD meshes read as machined parts instead of melted ones.
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  geometry.dispose();
  return flat;
}

/** Set an object's local pose from MuJoCo `pos` (3) and `quat` (4, w x y z) arrays at index `i`. */
function setLocal(obj: THREE.Object3D, pos: Float64Array, quat: Float64Array, i: number): void {
  obj.position.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
  obj.quaternion.set(quat[4 * i + 1], quat[4 * i + 2], quat[4 * i + 3], quat[4 * i]);
}

function visualGeoms(mj: MainModule, model: MjModel, bodies: THREE.Group[]): void {
  const type = model.geom_type as Int32Array;
  const group = model.geom_group as Int32Array;
  const size = model.geom_size as Float64Array;
  const bodyId = model.geom_bodyid as Int32Array;
  const dataId = model.geom_dataid as Int32Array;
  const matId = model.geom_matid as Int32Array;
  const geomRgba = model.geom_rgba as Float32Array;
  const matRgba = model.mat_rgba as Float32Array;
  const meshes = new Map<number, THREE.BufferGeometry>();
  for (let g = 0; g < model.ngeom; g += 1) {
    const [sx, sy, sz] = size.subarray(3 * g, 3 * g + 3);
    if (group[g] > MAX_VISUAL_GROUP || (bodyId[g] === 0 && Math.max(sx, sy, sz) > ROOM_HALF_SIZE)) continue;
    let geometry: THREE.BufferGeometry;
    if (type[g] === mj.mjtGeom.mjGEOM_BOX.value) {
      geometry = new THREE.BoxGeometry(2 * sx, 2 * sy, 2 * sz);
    } else if (type[g] === mj.mjtGeom.mjGEOM_MESH.value) {
      const id = dataId[g];
      geometry = meshes.get(id) ?? meshGeometry(model, id);
      meshes.set(id, geometry);
    } else {
      continue;
    }
    const m = matId[g];
    const [r, gr, b] = m >= 0 ? matRgba.subarray(4 * m, 4 * m + 3) : geomRgba.subarray(4 * g, 4 * g + 3);
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(r, gr, b, THREE.SRGBColorSpace), roughness: 0.58 });
    const mesh = new THREE.Mesh(geometry, material);
    setLocal(mesh, model.geom_pos as Float64Array, model.geom_quat as Float64Array, g);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    bodies[bodyId[g]].add(mesh);
  }
}

function buildStageModel(mj: MainModule, scene: Scene): StageModel {
  const { model } = scene;
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2; // MuJoCo is z-up
  const bodies = Array.from({ length: model.nbody }, () => new THREE.Group());
  root.add(...bodies);
  visualGeoms(mj, model, bodies);

  const camId = (name: CameraName) => {
    const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_CAMERA.value, name);
    if (id < 0) throw new Error(`scene.xml does not define camera "${name}"`);
    return id;
  };
  const ids = { front: camId("front"), wrist_cam: camId("wrist_cam") };
  const fovy = model.cam_fovy as Float64Array;
  const camBody = model.cam_bodyid as Int32Array;
  // MuJoCo cameras look down -z with +y up, as three.js cameras do: mount them as they are.
  const cameras = Object.fromEntries(
    CAMERA_NAMES.map((name) => {
      const cam = new THREE.PerspectiveCamera(fovy[ids[name]], CAMERA_SIZE.width / CAMERA_SIZE.height, 0.01, 10);
      bodies[camBody[ids[name]]].add(cam);
      return [name, cam];
    }),
  ) as Record<CameraName, THREE.PerspectiveCamera>;
  const mountCameras = () =>
    CAMERA_NAMES.forEach((name) => setLocal(cameras[name], model.cam_pos as Float64Array, model.cam_quat as Float64Array, ids[name]));

  const applyPoses = (poses: Float64Array) => {
    if (poses.length !== 7 * bodies.length) return;
    bodies.forEach((body, b) => {
      body.position.set(poses[7 * b], poses[7 * b + 1], poses[7 * b + 2]);
      body.quaternion.set(poses[7 * b + 4], poses[7 * b + 5], poses[7 * b + 6], poses[7 * b + 3]);
    });
  };

  mountCameras();
  applyPoses(scene.bodyPoses());
  return {
    root,
    cameras,
    applyPoses,
    reseed(seed) {
      scene.reset(seed);
      mountCameras();
      applyPoses(scene.bodyPoses());
    },
    dispose() {
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      });
      scene.data.delete();
      scene.model.delete();
    },
  };
}
