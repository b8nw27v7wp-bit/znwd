import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export type AvatarMood = 'idle' | 'thinking' | 'speaking';

interface Live2DStageProps {
  mood: AvatarMood;
}

/** 正式数字人：将授权文件命名为 hostess.vrm 放入 public/models/ */
const VRM_URL = '/models/hostess.vrm';

/** 通用职业女讲解员风格参数（不基于任何真人照片） */
const STYLE = {
  skin: 0xf2d4c2,
  hair: 0x1a1a1e,
  suit: 0x2c2c30,
  shirt: 0xf7f7f8,
  accent: 0x3db882,
  lips: 0xc4545a,
};

function createFaceTexture(): THREE.CanvasTexture {
  const w = 768;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = w;
  const g = c.getContext('2d')!;

  // 柔和底色 + 中心高光（示意鼻梁、前额）
  const base = g.createRadialGradient(w * 0.45, w * 0.35, w * 0.08, w * 0.5, w * 0.5, w * 0.7);
  base.addColorStop(0, '#f7dcc8');
  base.addColorStop(0.55, '#f0d0bc');
  base.addColorStop(1, '#e6c0aa');
  g.fillStyle = base;
  g.fillRect(0, 0, w, w);

  // 淡妆腮红
  const blush = (cx: number, cy: number) => {
    const rg = g.createRadialGradient(cx, cy, 4, cx, cy, 48);
    rg.addColorStop(0, 'rgba(220,140,130,0.42)');
    rg.addColorStop(1, 'rgba(220,140,130,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(cx, cy, 48, 0, Math.PI * 2);
    g.fill();
  };
  blush(w * 0.28, w * 0.58);
  blush(w * 0.72, w * 0.58);

  // 眉毛：柔和弓形
  g.strokeStyle = '#2f2a28';
  g.lineWidth = 9;
  g.lineCap = 'round';
  const brow = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) => {
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(cx, cy, x1, y1);
    g.stroke();
  };
  brow(w * 0.24, w * 0.4, w * 0.32, w * 0.345, w * 0.42, w * 0.4);
  brow(w * 0.58, w * 0.4, w * 0.68, w * 0.345, w * 0.76, w * 0.4);

  // 眼影
  const shadow = (cx: number, cy: number) => {
    const rg = g.createRadialGradient(cx, cy, 2, cx, cy, 36);
    rg.addColorStop(0, 'rgba(170,120,115,0.35)');
    rg.addColorStop(1, 'rgba(170,120,115,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.ellipse(cx, cy, 40, 16, 0, 0, Math.PI * 2);
    g.fill();
  };
  shadow(w * 0.32, w * 0.47);
  shadow(w * 0.68, w * 0.47);

  // 眼睛：杏仁形 + 高光
  const eye = (cx: number, cy: number) => {
    g.fillStyle = '#2b2b2e';
    g.beginPath();
    g.ellipse(cx, cy, 26, 28, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#1f1f22';
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(cx, cy, 28, 30, 0, Math.PI, 2 * Math.PI);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(cx + 8, cy - 8, 8, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(cx - 6, cy + 4, 3, 0, Math.PI * 2);
    g.fill();
  };
  eye(w * 0.32, w * 0.5);
  eye(w * 0.68, w * 0.5);

  // 鼻影
  g.strokeStyle = 'rgba(190,150,130,0.45)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(w * 0.5, w * 0.52);
  g.quadraticCurveTo(w * 0.48, w * 0.62, w * 0.46, w * 0.66);
  g.quadraticCurveTo(w * 0.5, w * 0.68, w * 0.54, w * 0.66);
  g.stroke();

  // 唇：偏暖珊瑚红
  const lip = STYLE.lips;
  g.fillStyle = `#${lip.toString(16).padStart(6, '0')}`;
  g.beginPath();
  g.moveTo(w * 0.4, w * 0.76);
  g.quadraticCurveTo(w * 0.46, w * 0.735, w * 0.5, w * 0.745);
  g.quadraticCurveTo(w * 0.54, w * 0.735, w * 0.6, w * 0.76);
  g.quadraticCurveTo(w * 0.55, w * 0.82, w * 0.5, w * 0.825);
  g.quadraticCurveTo(w * 0.45, w * 0.82, w * 0.4, w * 0.76);
  g.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

interface ProcChar {
  group: THREE.Group;
  head: THREE.Mesh;
  mouth: THREE.Mesh;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  faceMat: THREE.MeshStandardMaterial;
}

function buildProceduralHostess(): ProcChar {
  const group = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({ color: STYLE.skin, roughness: 0.68 });
  const hairMat = new THREE.MeshStandardMaterial({
    color: STYLE.hair,
    roughness: 0.32,
    metalness: 0.08,
  });
  const suit = new THREE.MeshStandardMaterial({ color: STYLE.suit, roughness: 0.82 });
  const shirt = new THREE.MeshStandardMaterial({ color: STYLE.shirt, roughness: 0.78 });
  const accent = new THREE.MeshStandardMaterial({ color: STYLE.accent, roughness: 0.55 });

  // 下装/躯干
  const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.35, 20), suit);
  hips.position.y = 0.42;
  hips.scale.z = 0.72;
  group.add(hips);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.42, 10, 20), suit);
  torso.position.y = 0.95;
  torso.scale.set(1, 1, 0.7);
  group.add(torso);

  // 收腰
  const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.22, 16), suit);
  waist.position.y = 0.72;
  waist.scale.z = 0.7;
  group.add(waist);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.18), shirt);
  chest.position.set(0, 1.16, 0.2);
  group.add(chest);

  // 西装翻领
  const lapelL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.26, 0.06), suit);
  lapelL.position.set(-0.12, 1.12, 0.26);
  lapelL.rotation.z = 0.25;
  group.add(lapelL);
  const lapelR = lapelL.clone();
  lapelR.position.x = 0.12;
  lapelR.rotation.z = -0.25;
  group.add(lapelR);

  const scarf = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.06), accent);
  scarf.position.set(0, 1.02, 0.26);
  group.add(scarf);

  // 手臂
  const armGeo = new THREE.CapsuleGeometry(0.095, 0.4, 8, 14);
  const leftArm = new THREE.Group();
  const lam = new THREE.Mesh(armGeo, suit);
  lam.position.y = -0.27;
  leftArm.add(lam);
  leftArm.position.set(-0.42, 1.22, 0);
  leftArm.rotation.z = 0.22;
  group.add(leftArm);

  const rightArm = new THREE.Group();
  const ram = new THREE.Mesh(armGeo, suit);
  ram.position.y = -0.27;
  rightArm.add(ram);
  rightArm.position.set(0.42, 1.22, 0);
  rightArm.rotation.z = -0.22;
  group.add(rightArm);

  const handGeo = new THREE.SphereGeometry(0.075, 14, 14);
  const handL = new THREE.Mesh(handGeo, skin);
  handL.position.set(0, -0.52, 0.02);
  leftArm.add(handL);
  const handR = handL.clone();
  rightArm.add(handR);

  // 颈 / 头（鹅蛋：y 略长）
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.16, 14), skin);
  neck.position.y = 1.4;
  group.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 40, 40), skin);
  head.scale.set(0.9, 1.06, 0.88);
  head.position.y = 1.66;
  group.add(head);

  const faceMat = new THREE.MeshStandardMaterial({
    map: createFaceTexture(),
    roughness: 0.65,
  });
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.215, 48), faceMat);
  face.position.set(0, 1.66, 0.238);
  group.add(face);

  // 黑色长发：中分顶盖 + 后披发 + 鬓角（利落盘起感 + 两侧垂发）
  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.295, 32, 32, 0, Math.PI * 2, 0, Math.PI * 0.52),
    hairMat,
  );
  hairCap.position.set(0, 1.7, 0);
  hairCap.scale.set(1.02, 0.92, 1.0);
  group.add(hairCap);

  // 后发披肩
  const hairBack = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.72, 8, 16), hairMat);
  hairBack.position.set(0, 1.35, -0.1);
  hairBack.scale.set(1.05, 1, 0.55);
  group.add(hairBack);

  // 两侧长直发丝
  const lockGeo = new THREE.CapsuleGeometry(0.045, 0.55, 6, 10);
  const lockL = new THREE.Mesh(lockGeo, hairMat);
  lockL.position.set(-0.26, 1.35, 0.1);
  group.add(lockL);
  const lockR = lockL.clone();
  lockR.position.x = 0.26;
  group.add(lockR);

  // 中分缝
  const part = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, 0.32), skin);
  part.position.set(0, 1.9, 0.02);
  group.add(part);

  // 口型（叠在唇部高度）
  const mouthMaterial = new THREE.MeshStandardMaterial({
    color: STYLE.lips,
    roughness: 0.45,
  });
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.032, 16, 16), mouthMaterial);
  mouth.position.set(0, 1.575, 0.25);
  mouth.scale.set(1.55, 0.5, 0.35);
  group.add(mouth);

  group.position.y = -0.85;
  return { group, head, mouth, leftArm, rightArm, faceMat };
}

export function Live2DStage({ mood }: Live2DStageProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const moodRef = useRef<AvatarMood>(mood);
  moodRef.current = mood;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 1.42, 2.55);
    camera.lookAt(0, 1.28, 0);

    scene.add(new THREE.HemisphereLight(0xfffaf5, 0xe8e8ed, 0.95));
    const key = new THREE.DirectionalLight(0xfff2e8, 0.95);
    key.position.set(1.6, 2.8, 3.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xdce8ff, 0.45);
    rim.position.set(-2, 1.5, -1);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-1.2, 0.8, 2.5);
    scene.add(fill);

    let disposed = false;
    let proc: ProcChar | null = buildProceduralHostess();
    scene.add(proc.group);
    let vrm: import('@pixiv/three-vrm').VRM | null = null;

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      VRM_URL,
      (gltf) => {
        if (disposed) return;
        const model = gltf.userData.vrm as import('@pixiv/three-vrm').VRM | undefined;
        if (!model || !proc) return;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        scene.remove(proc.group);
        vrm = model;
        vrm.scene.rotation.y = Math.PI;
        vrm.scene.position.y = -0.9;
        scene.add(vrm.scene);
      },
      undefined,
      () => {
        /* 无授权 VRM 时使用程序化角色 */
      },
    );

    const resize = () => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const clock = new THREE.Clock();
    let last = 0;
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      const dt = Math.min(0.05, t - last);
      last = t;
      const m = moodRef.current;

      if (proc) {
        proc.group.position.y = -0.85 + Math.sin(t * 1.35) * 0.01;
        const head = proc.head;
        head.rotation.y = m === 'thinking' ? Math.sin(t * 2.1) * 0.07 : Math.sin(t * 0.55) * 0.025;
        head.rotation.x = m === 'thinking' ? 0.035 : Math.sin(t * 0.8) * 0.015;
        if (m === 'speaking') {
          const open = 0.35 + Math.abs(Math.sin(t * 11)) * 0.9;
          proc.mouth.scale.set(1.7, open, 0.4);
        } else if (m === 'thinking') {
          proc.mouth.scale.set(1.4, 0.35, 0.35);
        } else {
          proc.mouth.scale.set(1.55, 0.5, 0.35);
        }
        proc.leftArm.rotation.x = m === 'speaking' ? Math.sin(t * 2.8) * 0.07 : 0;
        proc.rightArm.rotation.x = m === 'speaking' ? Math.sin(t * 2.8 + 0.8) * 0.07 : 0;
      }

      if (vrm) {
        vrm.update(dt);
        vrm.scene.position.y = -0.9 + Math.sin(t * 1.35) * 0.01;
        const human = vrm.humanoid;
        const headBone =
          human?.getRawBoneNode?.('head') ??
          (human && 'getBoneNode' in human
            ? (human as { getBoneNode: (n: string) => THREE.Object3D | null }).getBoneNode('head')
            : null);
        if (headBone) {
          headBone.rotation.y = m === 'thinking' ? Math.sin(t * 2) * 0.07 : 0;
        }
      }

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (vrm) {
        scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      if (proc) {
        scene.remove(proc.group);
        proc.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const mat = obj.material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat.dispose();
          }
        });
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="stage" data-mood={mood} aria-label="AI 虚拟讲解员">
      <div className="hostess hostess--3d">
        <div ref={mountRef} className="hostess-canvas" />
      </div>
    </div>
  );
}
