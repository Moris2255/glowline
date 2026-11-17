// Mikrofon-Aufnahme fuer die Spracheingabe: sammelt die Samples und schickt sie in Paketen an sprache.js
class Aufnahme extends AudioWorkletProcessor {
  constructor() { super(); this.teile = []; this.n = 0; }
  process(inputs) {
    const d = inputs[0] && inputs[0][0];
    if (d) {
      this.teile.push(new Float32Array(d));
      this.n += d.length;
      if (this.n >= 2048) {
        const out = new Float32Array(this.n);
        let o = 0;
        for (const t of this.teile) { out.set(t, o); o += t.length; }
        this.port.postMessage(out, [out.buffer]);
        this.teile = []; this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('aufnahme', Aufnahme);
