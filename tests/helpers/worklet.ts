/** Structural surface implemented by the bundled audio processor in VM tests. */
interface WorkletProcessor {
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
export type WorkletConstructor = new (options: {
  processorOptions: { recordingId: string };
}) => WorkletProcessor;
