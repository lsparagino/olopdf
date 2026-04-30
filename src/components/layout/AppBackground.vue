<script setup lang="ts">
// Animated dark gradient + floating blobs + subtle grain.
// Pulled out of base.css/background.css. The grain SVG is inlined as a CSS url() — no asset import.
const GRAIN_SVG =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>"
const grainStyle = { backgroundImage: `url("${GRAIN_SVG}")` }
</script>

<template>
  <div class="bg-gradient pointer-events-none fixed inset-0 -z-30" />
  <div class="bg-blobs pointer-events-none fixed inset-0 -z-20 overflow-hidden">
    <div class="blob blob-1" />
    <div class="blob blob-2" />
    <div class="blob blob-3" />
    <div class="blob blob-4" />
  </div>
  <div
    class="bg-grain pointer-events-none fixed inset-0 -z-10 mix-blend-overlay opacity-[0.035]"
    :style="grainStyle"
  />
</template>

<style scoped>
.bg-gradient {
  background:
    radial-gradient(1200px 800px at 10% 10%, #1a1240 0%, transparent 60%),
    radial-gradient(1000px 700px at 90% 90%, #2a0e3a 0%, transparent 60%),
    linear-gradient(135deg, #0a0a14 0%, #0d0a1f 100%);
}
.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.55;
  animation: float 22s var(--ease-out-soft) infinite;
  will-change: transform;
}
.blob-1 {
  width: 520px;
  height: 520px;
  left: -120px;
  top: -120px;
  background: radial-gradient(circle, #6b35ff 0%, transparent 70%);
}
.blob-2 {
  width: 460px;
  height: 460px;
  right: -100px;
  top: 30%;
  background: radial-gradient(circle, #ff3da6 0%, transparent 70%);
  animation-delay: -7s;
}
.blob-3 {
  width: 480px;
  height: 480px;
  left: 30%;
  bottom: -120px;
  background: radial-gradient(circle, #2dd4ff 0%, transparent 70%);
  animation-delay: -14s;
}
.blob-4 {
  width: 380px;
  height: 380px;
  right: 25%;
  top: -100px;
  background: radial-gradient(circle, #a78bfa 0%, transparent 70%);
  animation-delay: -3s;
}

@keyframes float {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  25% {
    transform: translate(60px, 40px) scale(1.06);
  }
  50% {
    transform: translate(-30px, 70px) scale(0.96);
  }
  75% {
    transform: translate(-50px, -30px) scale(1.04);
  }
}
</style>
