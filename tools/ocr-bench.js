/**
 * Plate-reading benchmark.
 *
 * Reading a clean rendered plate proves nothing -- the pipeline scored 83% on
 * those while failing in an actual car park. This generates plates the way a
 * phone really sees them (dust, shadow, glare, blur, sensor noise, 3D tilt,
 * sitting small inside a cluttered frame) and measures exact-match accuracy.
 *
 * It exists so that changing the recognition pipeline is a measurement rather
 * than an argument. Every claim about accuracy in this project came from here.
 *
 * HOW TO RUN
 *   1. Serve the app:  npm start      (or open the deployed site)
 *   2. Open the browser console and paste this whole file in
 *   3. await ocrBench()               -- or ocrBench({ levels: [0.3, 0.6, 0.9] })
 *
 * Results are seeded, so two runs over the same levels compare like for like.
 *
 * MEASURED SO FAR (Tesseract, on device)
 *   plate perfectly framed and filling the crop ... 83%
 *   realistic scene, plate large in frame ........ 45%
 *   realistic scene, plate small in frame ........ 30%
 */

globalThis.ocrBench = (function build() {
  const PLATES = [
    ['MH 12', 'AB 1234'], ['KA 05', 'MJ 8821'], ['DL 8C', 'AF 1234'],
    ['TN 09', 'BC 4455'], ['UP 16', 'DK 7702'], ['GJ 01', 'RT 5390'],
    ['RJ 14', 'PQ 6178'], ['MH 02', 'CZ 9043'], ['KL 07', 'BN 3316'],
    ['WB 06', 'HG 2284'],
  ];

  const seeded = (seed) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  /** A crisp two-row plate, before the world gets at it. */
  function clean(rows, W = 900, H = 450) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.strokeStyle = '#111'; x.lineWidth = 8; x.strokeRect(20, 20, W - 40, H - 40);
    x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'middle';
    let size = 140;
    do { x.font = `bold ${size}px Arial, sans-serif`; size -= 4; }
    while (Math.max(x.measureText(rows[0]).width, x.measureText(rows[1]).width) > W - 120
      && size > 50);
    x.fillText(rows[0], W / 2, H * 0.33);
    x.fillText(rows[1], W / 2, H * 0.70);
    return c;
  }

  /** Everything that happens to a plate between the factory and the car park. */
  function degrade(src, level, seed) {
    const rnd = seeded(seed);
    const W = src.width;
    const H = src.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const x = out.getContext('2d', { willReadFrequently: true });

    x.save();
    x.translate(W / 2, H / 2);
    x.rotate(((rnd() - 0.5) * 2 * 7 * level) * Math.PI / 180);
    x.scale(1 - 0.10 * level * rnd(), 1 - 0.06 * level * rnd());
    x.translate(-W / 2, -H / 2);
    x.drawImage(src, 0, 0);
    x.restore();

    const shadow = x.createLinearGradient(0, 0, W, H);
    shadow.addColorStop(0, `rgba(0,0,0,${0.05 + 0.35 * level * rnd()})`);
    shadow.addColorStop(0.5, 'rgba(0,0,0,0)');
    shadow.addColorStop(1, `rgba(0,0,0,${0.05 + 0.30 * level * rnd()})`);
    x.fillStyle = shadow; x.fillRect(0, 0, W, H);

    if (level > 0.4) {
      const glare = x.createRadialGradient(W * rnd(), H * rnd(), 10, W / 2, H / 2, W / 2);
      glare.addColorStop(0, `rgba(255,255,255,${0.30 * level})`);
      glare.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = glare; x.fillRect(0, 0, W, H);
    }

    for (let i = 0; i < Math.round(1800 * level); i += 1) {
      const alpha = 0.10 + 0.55 * rnd();
      x.fillStyle = rnd() > 0.5 ? `rgba(90,80,60,${alpha})` : `rgba(180,170,150,${alpha})`;
      x.beginPath(); x.arc(rnd() * W, rnd() * H, 1 + rnd() * 5 * level, 0, 7); x.fill();
    }

    if (level > 0.15) {
      const blurred = document.createElement('canvas');
      blurred.width = W; blurred.height = H;
      const bx = blurred.getContext('2d');
      bx.filter = `blur(${(0.6 + 2.2 * level).toFixed(2)}px)`;
      bx.drawImage(out, 0, 0);
      x.clearRect(0, 0, W, H); x.filter = 'none'; x.drawImage(blurred, 0, 0);
    }

    const image = x.getImageData(0, 0, W, H);
    const amp = 34 * level;
    for (let i = 0; i < image.data.length; i += 4) {
      const n = (rnd() - 0.5) * amp;
      image.data[i] += n; image.data[i + 1] += n; image.data[i + 2] += n;
    }
    x.putImageData(image, 0, 0);
    return out;
  }

  /** The plate as one thing among many in the guide box, not the whole picture. */
  function scene(rows, level, seed, { small = false } = {}) {
    const rnd = seeded(seed);
    const W = 1100;
    const H = 550;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });

    x.fillStyle = `hsl(${Math.round(rnd() * 360)}, ${10 + rnd() * 25}%, ${18 + rnd() * 30}%)`;
    x.fillRect(0, 0, W, H);
    for (let i = 0; i < 50; i += 1) {
      x.fillStyle = `hsla(${Math.round(rnd() * 360)},22%,${10 + rnd() * 60}%,${0.2 + rnd() * 0.5})`;
      x.fillRect(rnd() * W, rnd() * H, rnd() * 280, rnd() * 100);
    }

    const plate = degrade(clean(rows), level, seed);
    const width = W * (small ? 0.20 + 0.20 * rnd() : 0.45 + 0.35 * rnd());
    const height = width / 2;
    x.drawImage(plate, (W - width) * rnd(), (H - height) * rnd(), width, height);
    return c;
  }

  return async function ocrBench({
    levels = [0.3, 0.6], small = false, perPlate = 1, log = true,
  } = {}) {
    const { scanPlate } = await import('/ocr.js?bench=' + Date.now());
    const results = {};

    for (const level of levels) {
      const rows = [];
      for (const [index, plate] of PLATES.entries()) {
        for (let k = 0; k < perPlate; k += 1) {
          const expected = (plate[0] + plate[1]).replace(/\s/g, '');
          const canvas = scene(plate, level, index * 613 + k * 97 + 11, { small });
          const started = Date.now();
          const result = await scanPlate(canvas, {});
          const got = result.reading ? result.reading.plate : null;
          rows.push({
            expected,
            got,
            ok: got === expected,
            engine: result.engine,
            ms: Date.now() - started,
          });
        }
      }
      const hits = rows.filter((r) => r.ok).length;
      results[`level_${level}`] = {
        exact: `${hits}/${rows.length}`,
        percent: Math.round((hits / rows.length) * 100),
        avgMs: Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length),
        engines: [...new Set(rows.map((r) => r.engine))].join(','),
        misses: rows.filter((r) => !r.ok).map((r) => `${r.expected} -> ${r.got}`),
      };
      if (log) console.log(level, results[`level_${level}`]);
    }
    return results;
  };
}());
