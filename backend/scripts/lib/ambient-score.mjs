/**
 * A short ambient score, synthesized from scratch, so no music licence is involved.
 *
 *   - a tanpura-style bed: four strings plucked in the classic Pa, Sa, Sa, low-Sa cycle on a D
 *     drone, each pluck blooming into brighter harmonics the way the real instrument does;
 *   - a quiet open-fifth pad underneath;
 *   - a singing-bowl strike at each moment a line of text appears, lower and longer for the
 *     closing line, and a soft two-note chord when the end card arrives.
 *
 * Because the strikes are placed at the caller's timestamps, the music follows the words.
 * Returns interleaved 16-bit stereo PCM as a WAV buffer.
 */
const SR = 44100;
const TAU = Math.PI * 2;

// D is the tonic (Sa). Pa is the fifth below, so the bed sits warm and low.
const SA_LOW = 73.416; // D2
const PA = 110.0; // A2
const SA = 146.832; // D3

/** Adds a plucked string with harmonics that bloom upward after the attack. */
function pluck(buffers, freq, start, { gain, decay, pan }) {
  const length = Math.min(buffers[0].length, Math.floor((start + decay * 5) * SR));
  const first = Math.max(0, Math.floor(start * SR));
  const left = Math.cos((pan + 1) * (Math.PI / 4));
  const right = Math.sin((pan + 1) * (Math.PI / 4));
  const harmonics = 14;

  for (let n = first; n < length; n += 1) {
    const t = n / SR - start;
    const attack = 1 - Math.exp(-t / 0.012);
    const envelope = Math.exp(-t / decay) * attack;
    // Higher partials swell for the first second or so (the buzzing "jivari" bloom).
    const bloom = Math.min(1, t / 1.1);
    let sample = 0;

    for (let h = 1; h <= harmonics; h += 1) {
      const weight = (1 / h) * (h <= 2 ? 1 : 0.35 + 1.3 * bloom * Math.exp(-h / 9));
      const drift = 1 + 0.0006 * h * Math.sin(TAU * 0.31 * t + h);
      sample += weight * Math.sin(TAU * freq * h * drift * t);
    }

    const value = sample * envelope * gain;
    buffers[0][n] += value * left;
    buffers[1][n] += value * right;
  }
}

/** Adds a singing-bowl strike: inharmonic partials, a soft attack, a long fade. */
function bowl(buffers, freq, start, { gain, decay, pan = 0 }) {
  const partials = [
    [1, 1],
    [2.71, 0.5],
    [5.31, 0.22],
    [8.9, 0.09]
  ];
  const length = Math.min(buffers[0].length, Math.floor((start + decay * 5) * SR));
  const first = Math.max(0, Math.floor(start * SR));
  const left = Math.cos((pan + 1) * (Math.PI / 4));
  const right = Math.sin((pan + 1) * (Math.PI / 4));

  for (let n = first; n < length; n += 1) {
    const t = n / SR - start;
    const attack = 1 - Math.exp(-t / 0.02);
    let sample = 0;

    for (const [ratio, weight] of partials) {
      // Each partial dies faster than the one below it; a slow beat between two close
      // frequencies gives the bowl its shimmer.
      const fade = Math.exp(-t / (decay / ratio ** 0.6));
      sample +=
        weight * fade * (Math.sin(TAU * freq * ratio * t) + 0.6 * Math.sin(TAU * (freq * ratio + 1.7) * t));
    }

    const value = sample * attack * gain;
    buffers[0][n] += value * left;
    buffers[1][n] += value * right;
  }
}

/** A quiet sustained open fifth with a slow swell; louder where the end card arrives. */
function pad(buffers, total, cardStart) {
  const notes = [SA_LOW, PA, SA, PA * 2];

  for (let n = 0; n < buffers[0].length; n += 1) {
    const t = n / SR;
    const swell = 0.55 + 0.45 * Math.sin(TAU * 0.045 * t - 1.2);
    const lift = t > cardStart - 1.2 ? Math.min(1, (t - (cardStart - 1.2)) / 1.8) * 0.9 : 0;
    let sample = 0;

    notes.forEach((freq, index) => {
      sample += Math.sin(TAU * freq * t + index) * (1 / (index + 1.4));
    });

    const value = sample * 0.045 * (swell + lift);
    buffers[0][n] += value;
    buffers[1][n] += value * 0.96;
  }
}

/**
 * events: [{ t, kind }] where kind is "line", "payoff" or "card".
 * Returns a WAV buffer (16-bit stereo) of `total` seconds, before reverb and mastering.
 */
export function synthScore({ total, events }) {
  const samples = Math.floor(total * SR);
  const buffers = [new Float32Array(samples), new Float32Array(samples)];
  const cardStart = (events.find((event) => event.kind === "card") || { t: total - 3 }).t;

  // Tanpura cycle: Pa, Sa, Sa, low Sa, about 1.2 seconds apart, a little slower each round.
  const cycle = [
    [PA, -0.35],
    [SA, 0.2],
    [SA, -0.1],
    [SA_LOW, 0.35]
  ];
  let t = 0.1;
  let step = 0;

  while (t < total - 0.5) {
    const [freq, pan] = cycle[step % cycle.length];
    pluck(buffers, freq, t, { gain: freq < 100 ? 0.09 : 0.075, decay: 3.2, pan });
    t += step % cycle.length === cycle.length - 1 ? 1.9 : 1.15;
    step += 1;
  }

  pad(buffers, total, cardStart);

  // Bowl strikes follow the words. Notes stay inside the D pentatonic (D E F# A B).
  const lineNotes = [440.0, 587.33, 659.25, 739.99];
  let lineIndex = 0;

  for (const event of events) {
    if (event.kind === "line") {
      bowl(buffers, lineNotes[lineIndex % lineNotes.length], event.t, { gain: 0.07, decay: 3.4, pan: lineIndex % 2 ? 0.25 : -0.25 });
      lineIndex += 1;
    } else if (event.kind === "payoff") {
      bowl(buffers, 293.66, event.t, { gain: 0.1, decay: 5.2 });
      bowl(buffers, 440.0, event.t + 0.05, { gain: 0.04, decay: 4.2, pan: 0.2 });
    } else if (event.kind === "card") {
      bowl(buffers, 293.66, event.t, { gain: 0.085, decay: 4.2, pan: -0.15 });
      bowl(buffers, 587.33, event.t + 0.35, { gain: 0.06, decay: 3.6, pan: 0.2 });
    }
  }

  // Fade in and out, then write 16-bit PCM scaled to a safe peak.
  let peak = 0;

  for (let channel = 0; channel < 2; channel += 1) {
    for (let n = 0; n < samples; n += 1) {
      const time = n / SR;
      const fade = Math.min(1, time / 1.8) * Math.min(1, (total - time) / 2.8);
      buffers[channel][n] *= fade;
      peak = Math.max(peak, Math.abs(buffers[channel][n]));
    }
  }

  const scale = peak > 0 ? 0.8 / peak : 1;
  const data = Buffer.alloc(samples * 4);

  for (let n = 0; n < samples; n += 1) {
    data.writeInt16LE(Math.round(buffers[0][n] * scale * 32767), n * 4);
    data.writeInt16LE(Math.round(buffers[1][n] * scale * 32767), n * 4 + 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}
