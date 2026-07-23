export function createMailbox() {
  let tail = Promise.resolve();

  return {
    post(label, operation) {
      const result = tail.then(() => operation());
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
