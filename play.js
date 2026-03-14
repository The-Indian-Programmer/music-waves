
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const AUDIO_FILE = path.join(__dirname, 'song.mp3');
const LYRICS     = JSON.parse(fs.readFileSync(path.join(__dirname, 'lyrics.json')));


const mv = (r, c) => `\x1b[${r};${c}H`;
const cl = '\x1b[2K';
const A = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  hide   : '\x1b[?25l',
  show   : '\x1b[?25h',
  cls    : '\x1b[2J\x1b[3J\x1b[H',
  c0     : '\x1b[90m',   
  c1     : '\x1b[2m\x1b[36m', 
  c2     : '\x1b[36m',      
  c3     : '\x1b[96m',        
  c4     : '\x1b[1m\x1b[96m', 
  peak   : '\x1b[1m\x1b[97m',  
  yellow : '\x1b[93m',
  cyan   : '\x1b[96m',
  magenta: '\x1b[95m',
  white  : '\x1b[97m',
  purple : '\x1b[38;5;141m',
  blue   : '\x1b[94m',
  green  : '\x1b[92m',
  gray   : '\x1b[90m',
  red    : '\x1b[91m',
};

const W         = 68;
const WAVE_ROWS = 8;
const WAVE_TOP  = 3;
const WAVE_BOT  = WAVE_TOP + WAVE_ROWS - 1;  // 10
const R = {
  title: 1, sep1: 2,
  sep2: 11, prog: 12, sep3: 13,
  prev: 14, cur: 15, next: 16,
  sep4: 17, stat: 18,
};


const SONG_DUR    = 44.6;
const SR          = 8000; 
const FFT_SIZE    = 1024; 
const N_BARS      = 34;      
const BAR_W       = 1;
const GAP         = 1.5;

const WAVE_FPS    = 15;  
const ATTACK      = 0.45;   
const DECAY       = 0.85;   
const SPATIAL_SM  = 0.25;   
const AMP         = 1.8;    
const PEAK_HOLD   = 45;   
const PEAK_FALL   = 3;    

const CHAR_DELAY  = 90;


const LINES = [
  { words: [0,1,2,3,4],      text: 'Ye dil tanhaa kyun rahe'},
  { words: [5,6,7,8,9],      text: 'Kyun Hum tukadon mein jiyein'},
  { words: [10,11,12,13,14], text: 'Ye Dil Tanha Kyun Rahe'},
  { words: [15,16,17,18,19], text: 'Kyun Hum Tukadon Mein Jiyein' },
  { words: [20,21,22,23,24], text: 'Kyun Rooh Meri Yeh Sahe'},
  { words: [25,26,27,28,29], text: 'Main Adhoora Jee Raha Hoon'},
  { words: [30,31,32,33,34], text: 'Hardum Yeh Keh Raha Hoon'},
  { words: [35,36,37,38],    text: 'Mujhe Teri Zaroorat Hai'},
  { words: [39,40,41,42],    text: 'Mujhe Teri Zaroorat Hai'},
];
const lineOf   = wi => LINES.findIndex(l => l.words.includes(wi));
const nextText = li => (LINES[li + 1] || {}).text || '';


const barHeights  = new Float32Array(N_BARS).fill(0);
const rawHeights  = new Float32Array(N_BARS).fill(0);
const peakRow     = new Int8Array(N_BARS).fill(WAVE_ROWS - 1);
const peakHold    = new Int16Array(N_BARS).fill(0);
const peakFallCtr = new Int8Array(N_BARS).fill(0);

let pcmBuf  = Buffer.alloc(0);
let startMs = null;

let wordIndex = 0;
let curLnIdx  = -1;
let curCol    = 1;
const WORD_COLS = [A.yellow, A.cyan, A.white, A.magenta, A.blue, A.green];


const wr  = s => process.stdout.write(s);
const row = (r, s) => wr(mv(r, 1) + cl + s);
const sep = (r, ch) => row(r, A.gray + ch.repeat(W) + A.reset);

function drawShell() {
  wr(A.cls + A.hide);
  const title = '';
  const pad   = ' '.repeat(Math.floor((W - title.length) / 2));
  row(R.title, A.purple + A.bold + pad + title + A.reset);
  sep(R.sep1, '─');
  for (let r = WAVE_TOP; r <= WAVE_BOT; r++) row(r, '');
  sep(R.sep2, '─');
  row(R.prog, A.gray + '░'.repeat(W) + A.reset);
  sep(R.sep3, '┄');
  row(R.prev, '');
  row(R.cur,  '');
  row(R.next, A.gray + A.dim + nextText(-1) + A.reset);
  sep(R.sep4, '─');
  row(R.stat, A.gray + '  starting…' + A.reset);
}


function analyseBands(samples) {
  const out = new Float32Array(N_BARS);
  const len = samples.length;
  for (let b = 0; b < N_BARS; b++) {
    // Slight log curve gives more bass detail
    const t0 = Math.floor(len * (b / N_BARS) ** 1.3);
    const t1 = Math.floor(len * ((b + 1) / N_BARS) ** 1.3);
    const sz = Math.max(t1 - t0, 1);
    let sum = 0;
    for (let i = t0; i < t0 + sz && i < len; i++) sum += samples[i] * samples[i];
    out[b] = Math.sqrt(sum / sz);
  }
  return out;
}

const frameBytes = FFT_SIZE * 2;

function feedPCM(chunk) {
  pcmBuf = Buffer.concat([pcmBuf, chunk]);

  while (pcmBuf.length >= frameBytes) {
    const sl = pcmBuf.slice(0, frameBytes);
    pcmBuf   = pcmBuf.slice(frameBytes);

    const samples = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++)
      samples[i] = sl.readInt16LE(i * 2) / 32768.0;

    const bands = analyseBands(samples);

    for (let b = 0; b < N_BARS; b++) {
      const target = Math.min(bands[b] * AMP, 1.0);
      if (target > rawHeights[b]) {
        rawHeights[b] = rawHeights[b] * (1 - ATTACK) + target * ATTACK;
      } else {
        rawHeights[b] = rawHeights[b] * DECAY + target * (1 - DECAY);
      }
    }

    for (let b = 0; b < N_BARS; b++) {
      const left  = rawHeights[Math.max(b - 1, 0)];
      const right = rawHeights[Math.min(b + 1, N_BARS - 1)];
      barHeights[b] = rawHeights[b] * (1 - SPATIAL_SM) +
                      ((left + right) / 2) * SPATIAL_SM;
    }

    for (let b = 0; b < N_BARS; b++) {
      const h           = barHeights[b];
      const filledRows  = Math.max(Math.round(h * WAVE_ROWS), h > 0.02 ? 1 : 0);
      const barTopRow   = WAVE_ROWS - filledRows; 

      if (barTopRow <= peakRow[b]) {
        peakRow[b]     = barTopRow;
        peakHold[b]    = PEAK_HOLD;
        peakFallCtr[b] = 0;
      } else {
        if (peakHold[b] > 0) {
          peakHold[b]--;
        } else {
          peakFallCtr[b]++;
          if (peakFallCtr[b] >= PEAK_FALL) {
            peakFallCtr[b] = 0;
            peakRow[b] = Math.min(peakRow[b] + 1, WAVE_ROWS - 1);
          }
        }
      }
    }
  }
}

function drawEqualizer() {
  for (let rowOffset = 0; rowOffset < WAVE_ROWS; rowOffset++) {
    const termRow = WAVE_TOP + rowOffset;
    let line = mv(termRow, 1) + cl;

    for (let b = 0; b < N_BARS; b++) {
      const h          = barHeights[b];
      const filledRows = Math.max(Math.round(h * WAVE_ROWS), h > 0.02 ? 1 : 0);
      const barTopRow  = WAVE_ROWS - filledRows;
      const isFilled   = rowOffset >= barTopRow;
      const isPeak     = rowOffset === peakRow[b] && peakRow[b] < barTopRow;

      let cell;

      if (isPeak) {
        cell = A.peak + '▀'.repeat(BAR_W) + A.reset;

      } else if (isFilled) {
        const posInBar    = rowOffset - barTopRow;
        const fracFromTop = filledRows > 1 ? posInBar / (filledRows - 1) : 0;

        let color;
        if      (fracFromTop < 0.12) color = A.c4; 
        else if (fracFromTop < 0.35) color = A.c3; 
        else if (fracFromTop < 0.65) color = A.c2; 
        else                         color = A.c1; 

        cell = color + '█'.repeat(BAR_W) + A.reset;

      } else if (rowOffset === WAVE_ROWS - 1 && h < 0.02) {
        cell = A.c0 + '▁'.repeat(BAR_W) + A.reset;

      } else {
        cell = ' '.repeat(BAR_W);
      }

      line += cell + ' '.repeat(GAP);
    }

    wr(line);
  }
}

function drawProgress() {
  if (!startMs) return;
  const elapsed = (Date.now() - startMs) / 1000;
  const pct     = Math.min(elapsed / SONG_DUR, 1);
  const filled  = Math.floor(pct * W);
  const fmtT    = s => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
  wr(mv(R.prog, 1) + cl +
    A.purple + '█'.repeat(filled) +
    A.gray   + '░'.repeat(W - filled) + A.reset +
    A.gray   + `  ${fmtT(elapsed)} / ${fmtT(SONG_DUR)}` + A.reset);
}


function typeWord(word, color) {
  return new Promise(resolve => {
    const chars = [...word];
    let i = 0;
    function nextChar() {
      if (i >= chars.length) {
        wr(mv(R.cur, curCol) + ' ');
        curCol++;
        return resolve();
      }
      wr(mv(R.cur, curCol) + color + chars[i] + A.reset);
      curCol++;
      i++;
      setTimeout(nextChar, CHAR_DELAY);
    }
    nextChar();
  });
}


async function syncLyrics() {
  while (wordIndex < LYRICS.words.length) {
    const wordObj = LYRICS.words[wordIndex];

    await new Promise(resolve => {
      (function poll() {
        if (!startMs || (Date.now() - startMs) / 1000 < wordObj.time)
          setImmediate(poll);
        else
          resolve();
      })();
    });

    const li      = lineOf(wordIndex);
    const newLine = li !== curLnIdx;

    if (newLine) {
      const prev = curLnIdx >= 0 ? LINES[curLnIdx].text : '';
      row(R.prev, A.gray + A.dim + prev + A.reset);
      row(R.next, A.gray + A.dim + nextText(li) + A.reset);
      row(R.cur,  '');
      curCol   = 1;
      curLnIdx = li;
    }

    await typeWord(wordObj.word, WORD_COLS[wordIndex % WORD_COLS.length]);
    wordIndex++;
  }

  setTimeout(() => {
    row(R.stat, A.green + '  ✓  Finished.' + A.reset);
    wr(A.show + mv(R.stat + 2, 1) + '\n');
    process.exit(0);
  }, 1500);
}


function findPlayer() {
  const opts = [
    { cmd: 'ffplay',  args: ['-nodisp', '-autoexit', '-loglevel', 'quiet'] },
    { cmd: 'mpg123',  args: ['-q'] },
    { cmd: 'afplay',  args: [] },
    { cmd: 'mplayer', args: ['-really-quiet', '-novideo'] },
    { cmd: 'cvlc',    args: ['--play-and-exit', '--no-video', '-q'] },
  ];
  for (const p of opts) {
    try { execSync(`which ${p.cmd}`, { stdio: 'ignore' }); return p; }
    catch (_) {}
  }
  return null;
}

drawShell();

const player = findPlayer();
if (!player) {
  row(R.stat, A.red + '  ✗  No player found. Install ffmpeg or mpg123.' + A.reset);
} else {
  spawn(player.cmd, [...player.args, AUDIO_FILE], { stdio: 'ignore' })
    .on('error', e => row(R.stat, A.red + `  ✗  ${e.message}` + A.reset));
}

const pcm = spawn('ffmpeg', [
  '-re',
  '-i', AUDIO_FILE,
  '-ac', '1',
  '-ar', String(SR),
  '-f', 's16le',
  '-loglevel', 'quiet',
  'pipe:1',
]);

let launched = false;

pcm.stdout.on('data', chunk => {
  feedPCM(chunk);

  if (!launched) {
    launched = true;
    startMs  = Date.now();

    setInterval(() => {
      drawEqualizer();
      drawProgress();
    }, Math.floor(1000 / WAVE_FPS));

    syncLyrics();

    row(R.stat, A.gray + `  ♪  ${player ? player.cmd : 'no audio'}` + A.reset);
  }
});

pcm.on('error', () =>
  row(R.stat, A.red + '  ✗  ffmpeg not found — https://ffmpeg.org/download.html' + A.reset)
);

process.on('SIGINT', () => {
  wr(A.show + A.reset + mv(R.stat + 2, 1) + '\n');
  process.exit(0);
});