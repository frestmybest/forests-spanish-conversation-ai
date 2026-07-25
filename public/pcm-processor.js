// Runs on the browser's audio thread. Collects microphone samples and posts
// them back to the main thread in ~100ms chunks of Float32 PCM.
class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.total = 0;
    this.target = 1600; // 100ms at 16kHz
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.chunks.push(new Float32Array(channel));
      this.total += channel.length;

      if (this.total >= this.target) {
        const out = new Float32Array(this.total);
        let offset = 0;
        for (const c of this.chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        this.chunks = [];
        this.total = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);
