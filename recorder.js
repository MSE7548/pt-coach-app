// 녹음과 4중 안전망. 종료 누락은 실수가 아니라 개인정보 사고다 —
// 다음 수업까지 녹음이 이어지면 동의하지 않은 회원의 발화가 들어간다.

export const CHUNK_MS = 5 * 60 * 1000;   // 최악의 경우에도 마지막 5분만 잃는다
const SILENCE_WARN_MS = 5 * 60 * 1000;   // 무음 5분이면 알린다
const SILENCE_STOP_MS = 10 * 60 * 1000;  // 무음 10분이면 자동 종료
const NOTIFY_MS = 55 * 60 * 1000;        // 수업이 50~55분이다
const LATE_MS = 70 * 60 * 1000;          // 70분이면 잊은 것으로 본다
const HARD_STOP_MS = 90 * 60 * 1000;     // 최후의 상한
const SILENCE_LEVEL = 0.012;             // 소리 크기만 읽는다. 음성 인식이 아니다

export class Recorder {
  constructor(handlers = {}) {
    this.on = handlers;
    this.chunkCount = 0;
    this.bytes = 0;
    this.startedAt = 0;
    this.stopped = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, channelCount: 1 }
    });

    const mime = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mimeType = this.recorder.mimeType || mime || 'audio/webm';

    this.recorder.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      this.bytes += e.data.size;
      this.on.chunk?.(e.data, this.chunkCount++, this.bytes);
    };
    this.recorder.onerror = e => this.on.error?.(e.error);

    const track = this.stream.getAudioTracks()[0];
    track.onended = () => this.on.lost?.('마이크가 끊겼습니다');
    track.onmute = () => this.on.lost?.('다른 앱이 마이크를 가져갔습니다');

    this.recorder.start(CHUNK_MS);
    this.startedAt = Date.now();
    this.#watchSilence();
    this.#watchClock();
  }

  get elapsed() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  async stop() {
    if (this.stopped) return null;
    this.stopped = true;
    clearInterval(this.clockTimer);
    cancelAnimationFrame(this.silenceFrame);

    const flushed = new Promise(resolve => {
      if (!this.recorder || this.recorder.state === 'inactive') return resolve();
      this.recorder.onstop = () => resolve();
      this.recorder.stop();
    });
    await flushed;

    this.audioCtx?.close().catch(() => {});
    this.stream?.getTracks().forEach(t => t.stop());
    return { mimeType: this.mimeType, chunks: this.chunkCount, bytes: this.bytes, ms: this.elapsed };
  }

  // 소리 크기만 본다. 음성 인식이 아니라 배터리 부담이 작다.
  #watchSilence() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      this.audioCtx.createMediaStreamSource(this.stream).connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      let quietSince = 0;
      let warned = false;

      const tick = () => {
        if (this.stopped) return;
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);

        if (peak < SILENCE_LEVEL) {
          if (!quietSince) quietSince = Date.now();
          const quiet = Date.now() - quietSince;
          if (quiet > SILENCE_STOP_MS) { this.on.autoStop?.('무음 10분'); return; }
          if (quiet > SILENCE_WARN_MS && !warned) { warned = true; this.on.silence?.(); }
        } else {
          quietSince = 0;
          warned = false;
        }
        this.silenceFrame = requestAnimationFrame(tick);
      };
      this.silenceFrame = requestAnimationFrame(tick);
    } catch {
      // 무음 감지가 안 되면 시간 상한만으로 통제한다.
    }
  }

  #watchClock() {
    let notified = false;
    let late = false;
    this.clockTimer = setInterval(() => {
      if (this.stopped) return;
      const ms = this.elapsed;
      this.on.tick?.(ms);
      if (ms > HARD_STOP_MS) { this.on.autoStop?.('90분 상한'); return; }
      if (ms > LATE_MS && !late) { late = true; this.on.overrun?.(70); }
      if (ms > NOTIFY_MS && !notified) { notified = true; this.on.overrun?.(55); }
    }, 1000);
  }
}

function pickMimeType() {
  const wanted = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return wanted.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
}

export function extensionFor(mimeType) {
  return (mimeType || '').includes('mp4') ? 'm4a' : 'webm';
}
