export class WorldSessionRegistry {
  #createSession;

  #defaultSession;

  #hasDefaultSession = false;

  constructor({ createSession }) {
    if (typeof createSession !== 'function') {
      throw new Error('WORLD_SESSION_FACTORY_REQUIRED');
    }
    this.#createSession = createSession;
  }

  get(worldId) {
    if (worldId !== 'default') {
      throw new Error('WORLD_NOT_SUPPORTED');
    }
    if (!this.#hasDefaultSession) {
      this.#defaultSession = this.#createSession();
      this.#hasDefaultSession = true;
    }
    return this.#defaultSession;
  }
}
