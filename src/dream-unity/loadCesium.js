/** Load the production globe engine without blocking the welcome document. */
export function createCesiumLoader({
  documentRef = globalThis.document,
  globalRef = globalThis,
  source = '/cesium/Cesium.js',
  timeoutMs = 45_000,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  let pending;
  const ready = () => typeof globalRef.Cesium?.Viewer === 'function';

  return function loadCesium() {
    if (ready()) return Promise.resolve();
    if (pending) return pending;

    const task = new Promise((resolve, reject) => {
      const script = documentRef.createElement('script');
      script.src = source;
      script.async = true;
      let timer;
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeoutImpl(timer);
        script.onload = null;
        script.onerror = null;
        if (error) {
          script.remove();
          reject(error);
        } else {
          resolve();
        }
      };
      script.onload = () =>
        finish(
          ready() ? null : new Error('The globe engine did not initialize.'),
        );
      script.onerror = () =>
        finish(new Error('The globe engine could not be downloaded.'));
      timer = setTimeoutImpl(
        () => finish(new Error('The globe engine download timed out.')),
        timeoutMs,
      );
      try {
        documentRef.head.appendChild(script);
      } catch (error) {
        finish(error);
      }
    });
    pending = task;
    // A failed script load has not evaluated the application module. A later
    // attempt can download a fresh script instead of retaining a rejection.
    void task.catch(() => {
      if (pending === task) pending = null;
    });
    return task;
  };
}
