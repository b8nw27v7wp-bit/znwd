import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export type AvatarMood = 'idle' | 'thinking' | 'speaking';

interface Live2DStageProps {
  mood: AvatarMood;
}

const VRM_URL = '/models/hostess.vrm';

function createFaceTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  // 妆面底：偏白肤色
  g.fillStyle = '#f0d0bc';
  g.fillRect(0, 0, 512, 512);
  // 淡妆腮红
  g.fillStyle = 'rgba(220,140,130,0.35)';
  g.beginPath();
  g.ellipse(140, 300, 42, 24, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(372, 300, 42, 24, 0, 0, Math.PI * 2);
  g.fill();
  // 眉
  g.strokeStyle = '#2a2a2e';
  g.lineWidth = 10;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(150, 220);
  g.quadraticCurveTo(190, 200, 230, 215);
  g.stroke();
  g.beginPath();
  g.moveTo(282, 215);
  g.quadraticCurveTo(322, 200, 362, 220);
  g.stroke();
  // 眼线 + 瞳
  g.fillStyle = '#2b2b2e';
  g.beginPath();
  g.ellipse(190, 270, 22, 26, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(322, 270, 22, 26, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(198, 262, 7, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(330, 262, 7, 0, Math.PI * 2);
  g.fill();
  // 眼影淡彩
  g.fillStyle = 'rgba(180,120,120,0.25)';
  g.beginPath();
  g.ellipse(190, 245, 28, 12, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(322, 245, 28, 12, 0, 0, Math.PI * 2);
  g.fill();
  // 鼻
  g.strokeStyle = 'rgba(180,140,120,0.5)';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(256, 280);
  g.lineTo(250, 340);
  g.lineTo(268, 342);
  g.stroke();
  // 唇
  g.fillStyle = '#c45c5c';
  g.beginPath();
  g.moveTo(220, 400);
  g.quadraticCurveTo(256, 385, 292, 400);
  g.quadraticCurveTo(256, 425, 220, 400);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface ProcChar {
  group: THREE.Group;
  head: THREE.Mesh;
  mouth: THREE.Mesh;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  hairBack: THREE.Object3D;
  mouthMaterial: THREE.MeshStandardMaterial;
}

/** 原创职业女讲解员（几何体 + 人脸贴图），不对照任何真人 */
function buildProceduralHostess(): ProcChar {
  const group = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({ color: 0xf0d0bc, roughness: 0.75 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.45 });
  const suit = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.85 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.8 });
  const green = new THREE.MeshStandardMaterial({ color: 0x3db882, roughness: 0.6 });

  // 躯干（西装）
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.55, 8, 16), suit);
  torso.position.y = 0.95;
  torso.scale.set(1, 1, 0.72);
  group.add(torso);

  // 衬衫
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.2), shirt);
  chest.position.set(0, 1.18, 0.22);
  group.add(chest);

  // 绿色丝巾
  const scarf = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.32, 0.08), green);
  scarf.position.set(0, 1.05, 0.28);
  group.add(scarf);

  // 手臂
  const armGeo = new THREE.CapsuleGeometry(0.11, 0.42, 6, 12);
  const leftArm = new THREE.Group();
  const leftArmMesh = new THREE.Mesh(armGeo, suit);
  leftArmMesh.position.y = -0.28;
  leftArm.add(leftArmMesh);
  leftArm.position.set(-0.48, 1.25, 0);
  leftArm.rotation.z = 0.25;
  group.add(leftArm);

  const rightArm = new THREE.Group();
  const rightArmMesh = new THREE.Mesh(armGeo, suit);
  rightArmMesh.position.y = -0.28;
  rightArm.add(rightArmMesh);
  rightArm.position.set(0.48, 1.25, 0);
  rightArm.rotation.z = -0.25;
  group.add(rightArm);

  // 手
  const handGeo = new THREE.SphereGeometry(0.09, 12, 12);
  const handL = new THREE.Mesh(handGeo, skin);
  handL.position.set(0, -0.55, 0);
  leftArm.add(handL);
  const handR = handL.clone();
  rightArm.add(handR);

  // 颈
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.14, 12), skin);
  neck.position.y = 1.42;
  group.add(neck);

  // 头（鹅蛋脸：纵向略长）
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 32, 32), skin);
  head.scale.set(0.92, 1.08, 0.88);
  head.position.y = 1.68;
  group.add(head);

  // 人脸贴图
  const faceMat = new THREE.MeshStandardMaterial({
    map: createFaceTexture(),
    roughness: 0.7,
  });
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.22, 32), faceMat);
  face.position.set(0, 1.68, 0.245);
  group.add(face);

  // 长直发：后发板 + 顶发 + 侧发
  const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.95, 0.22), hairMat);
  hairBack.position.set(0, 1.45, -0.12);
  group.add(hairBack);

  const hairTop = new THREE.Mesh(new THREE.SphereGeometry(0.31, 24, 24, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
  hairTop.position.set(0, 1.72, 0);
  hairTop.scale.set(1.05, 0.95, 1.0);
  group.add(hairTop);

  const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.14), hairMat);
  sideL.position.set(-0.28, 1.42, 0.08);
  group.add(sideL);
  const sideR = sideL.clone();
  sideR.position.x = 0.28;
  group.add(sideR);

  // 刘海
  const bangs = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.12, 0.08), hairMat);
  bangs.position.set(0, 1.82, 0.2);
  group.add(bangs);

  // 口型
  const mouthMaterial = new THREE.MeshStandardMaterial({ color: 0xc45c5c, roughness: 0.55 });
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), mouthMaterial);
  mouth.position.set(0, 1.58, 0.26);
  mouth.scale.set(1.4, 0.55, 0.4);
  group.add(mouth);

  group.position.y = -0.9;
  return { group, head, mouth, leftArm, rightArm, hairBack, mouthMaterial };
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
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    camera.position.set(0, 1.35, 3.2);
    camera.lookAt(0, 1.25, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xf0f0f5, 1.05);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(2, 3, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.35);
    fill.position.set(-2, 1, 2);
    scene.add(fill);

    let proc: ProcChar | null = null;
    let vrm: import('@pixiv/three-vrm').VRM | null = null;
    let disposed = false;

    proc = buildProceduralHostess();
    scene.add(proc.group);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      VRM_URL,
      (gltf) => {
        if (disposed) return;
        const model = gltf.userData.vrm as import('@pixiv/three-vrm').VRM | undefined;
        if (!model || !proc) return;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        scene.remove(proc.group);
        vrm = model;
        vrm.scene.rotation.y = Math.PI;
        vrm.scene.position.y = -0.9;
        scene.add(vrm.scene);
      },
      undefined,
      () => {
        // 无 VRM 时保留程序化形象
      },
    );

    const resize = () => {
      const w = mount.clientWidth || 320;
      const h = mount.clientHeight || 420;
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
        const breath = m === 'speaking' ? 0.012 : 0.008;
        proc.group.position.y = -0.9 + Math.sin(t * (m === 'thinking' ? 2.2 : 1.4)) * breath;
        proc.head.rotation.y = m === 'thinking' ? Math.sin(t * 2.4) * 0.08 : Math.sin(t * 0.7) * 0.03;
        proc.head.rotation.x = m === 'thinking' ? 0.04 : Math.sin(t * 0.9) * 0.02;
        if (m === 'speaking') {
          const open = 0.4 + Math.abs(Math.sin(t * 12)) * 0.85;
          proc.mouth.scale.set(1.5, open, 0.45);
        } else {
          proc.mouth.scale.set(1.35, 0.45, 0.4);
        }
        proc.leftArm.rotation.x = m === 'speaking' ? Math.sin(t * 3) * 0.08 : 0;
        proc.rightArm.rotation.x = m === 'speaking' ? Math.sin(t * 3 + 1) * 0.08 : 0;
      }

      if (vrm) {
        vrm.update(dt);
        const s = vrm.scene;
        s.position.y = -0.9 + Math.sin(t * 1.4) * 0.01;
        if (m === 'thinking' && vrm.lookAt) {
          vrm.lookAt.target?.position.set(Math.sin(t) * 0.5, 1.4, 2);
        }
        const human = vrm.humanoid;
        if (human) {
          const head = human.getRawBoneNode('head');
          if (head) {
            head.rotation.y = m === 'thinking' ? Math.sin(t * 2.2) * 0.08 : 0;
          }
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
        vrm = null;
      }
      if (proc) {
        scene.remove(proc.group);
        proc.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
            else obj.material.dispose();
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
