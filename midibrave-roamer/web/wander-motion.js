/** Smooth orbital drift for latent XY. It owns motion only, never gate or pitch. */
export class WanderMotion {
  constructor(random = Math.random) {
    this.random = random;
    this.angle = 0;
    this.curvature = 0;
    this.targetCurvature = 0;
    this.lastTime = null;
  }

  reset(_point, time) {
    this.angle = this.random() * Math.PI * 2;
    this.curvature = this.#nextCurvature();
    this.targetCurvature = this.curvature;
    this.lastTime = Number(time);
  }

  step(point, time, { speed, turnRate, boundary = 0.88 }) {
    const now = Number(time);
    if (!Number.isFinite(this.lastTime)) this.reset(point, now);
    const dt = Math.max(0, Math.min(0.1, (now - this.lastTime) / 1000));
    this.lastTime = now;

    if (turnRate > 0 && this.random() < turnRate * dt) {
      this.targetCurvature = this.#nextCurvature();
    }

    // Curvature changes are damped instead of applied as instant heading jumps.
    const curvatureBlend = 1 - Math.exp(-3 * dt);
    this.curvature += (this.targetCurvature - this.curvature) * curvatureBlend;
    this.angle += this.curvature * dt;

    // A soft edge force bends the trajectory back into the map. This is the
    // single-agent part borrowed from boids: steer velocity, do not teleport or
    // mirror it. The clamp below remains only as a numerical safety net.
    const px = Number(point.x);
    const py = Number(point.y);
    const edgeStart = boundary * 0.7;
    const edgeWidth = Math.max(0.001, boundary - edgeStart);
    const inwardX = this.#edgeForce(px, edgeStart, edgeWidth);
    const inwardY = this.#edgeForce(py, edgeStart, edgeWidth);
    if (inwardX || inwardY) {
      const vx = Math.cos(this.angle) + inwardX * 7 * dt;
      const vy = Math.sin(this.angle) + inwardY * 7 * dt;
      this.angle = Math.atan2(vy, vx);
    }

    const distance = Math.max(0, Number(speed)) * dt;
    const x = Math.max(-boundary, Math.min(boundary, px + Math.cos(this.angle) * distance));
    const y = Math.max(-boundary, Math.min(boundary, py + Math.sin(this.angle) * distance));
    return { x, y };
  }

  #nextCurvature() {
    const value = this.random() * 2 - 1;
    const direction = value < 0 ? -1 : 1;
    return direction * (0.22 + Math.abs(value) * 0.78);
  }

  #edgeForce(value, edgeStart, edgeWidth) {
    const pressure = Math.max(0, (Math.abs(value) - edgeStart) / edgeWidth);
    return pressure ? -Math.sign(value) * Math.min(1, pressure) ** 2 : 0;
  }
}
