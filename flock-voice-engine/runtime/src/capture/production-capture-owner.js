export function createProductionCaptureOwner() {
  const failure = new Promise(() => {});
  return Object.freeze({
    start() {
      return Promise.resolve(true);
    },
    close() {
      return Promise.resolve(true);
    },
    waitForFailure() {
      return failure;
    },
  });
}
