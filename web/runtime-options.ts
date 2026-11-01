/** Bound ONNX CPU parallelism; SharedArrayBuffer requires browser isolation. */
export function wasmThreadCount(isolated: boolean, cores: unknown) {
  if (!isolated || typeof cores !== 'number' || !Number.isFinite(cores) || cores < 2) return 1;
  return Math.min(4, Math.max(1, Math.floor(cores / 2)));
}
