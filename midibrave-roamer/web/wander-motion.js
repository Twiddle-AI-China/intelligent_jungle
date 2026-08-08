/** Bounded random walk for latent XY. It owns motion only, never gate or pitch. */
export class WanderMotion {
  constructor(random = Math.random) {
    this.random = random;
    this.angle = 0;
    this.lastTime = null;
  }

  reset(_point, time) {
    this.angle = this.random() * Math.PI * 2;
    this.lastTime = Number(time);
  }

  step(point, time, { speed, turnRate, boundary = 0.88 }) {
    const now = Number(time);
    if (!Number.isFinite(this.lastTime)) this.reset(point, now);
    const dt = Math.max(0, Math.min(0.1, (now - this.lastTime) / 1000));
    this.lastTime = now;

    if (turnRate > 0 && this.random() < turnRate * dt) {
      this.angle += (this.random() * 2 - 1) * Math.PI;
    }

    let x = Number(point.x) + Math.cos(this.angle) * speed * dt;
    let y = Number(point.y) + Math.sin(this.angle) * speed * dt;
    if (x > boundary || x < -boundary) {
      x = Math.max(-boundary, Math.min(boundary, x));
      this.angle = Math.PI - this.angle;
    }
    if (y > boundary || y < -boundary) {
      y = Math.max(-boundary, Math.min(boundary, y));
      this.angle = -this.angle;
    }
    return { x, y };
  }
}
