// ShareWeb AirDrop-Style Sound Effects & Haptic Feedback Engine
(function() {
  let audioCtx = null;

  function getAudioContext() {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        audioCtx = new AudioContext();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Pre-warm audio context on first user interaction
  const unlockAudio = () => {
    getAudioContext();
    window.removeEventListener('click', unlockAudio, true);
    window.removeEventListener('touchstart', unlockAudio, true);
  };
  window.addEventListener('click', unlockAudio, true);
  window.addEventListener('touchstart', unlockAudio, true);

  const SoundEngine = {
    isSoundEnabled() {
      const val = localStorage.getItem('sw_sound_enabled') ?? localStorage.getItem('ds-sound-enabled');
      return val === null ? true : val === 'true';
    },

    setSoundEnabled(enabled) {
      const str = enabled ? 'true' : 'false';
      localStorage.setItem('sw_sound_enabled', str);
      localStorage.setItem('ds-sound-enabled', str);
    },

    triggerHaptic(pattern = [30, 40, 30]) {
      if (!this.isSoundEnabled()) return;
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(pattern);
        } catch {}
      }
    },

    playChime(type) {
      if (!this.isSoundEnabled()) return;
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;

      switch (type) {
        case 'peer-found': {
          // Harmonic dual ping: 880Hz (A5) with octave 1760Hz
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gainNode = ctx.createGain();

          osc1.type = 'sine';
          osc1.frequency.setValueAtTime(880, now);

          osc2.type = 'sine';
          osc2.frequency.setValueAtTime(1760, now);

          gainNode.gain.setValueAtTime(0.12, now);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

          osc1.connect(gainNode);
          osc2.connect(gainNode);
          gainNode.connect(ctx.destination);

          osc1.start(now);
          osc2.start(now);
          osc1.stop(now + 0.35);
          osc2.stop(now + 0.35);
          this.triggerHaptic([25]);
          break;
        }

        case 'send-start': {
          // Soft ascending whoosh
          const osc = ctx.createOscillator();
          const gainNode = ctx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(420, now);
          osc.frequency.exponentialRampToValueAtTime(840, now + 0.22);

          gainNode.gain.setValueAtTime(0.08, now);
          gainNode.gain.linearRampToValueAtTime(0.14, now + 0.1);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

          osc.connect(gainNode);
          gainNode.connect(ctx.destination);

          osc.start(now);
          osc.stop(now + 0.25);
          this.triggerHaptic([20]);
          break;
        }

        case 'transfer-complete': {
          // Apple AirDrop-style dual bell ding: 587Hz (D5) then 880Hz (A5)
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gain1 = ctx.createGain();
          const gain2 = ctx.createGain();

          osc1.type = 'triangle';
          osc1.frequency.setValueAtTime(587.33, now);
          gain1.gain.setValueAtTime(0.18, now);
          gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

          osc2.type = 'sine';
          osc2.frequency.setValueAtTime(880, now + 0.09);
          gain2.gain.setValueAtTime(0.001, now);
          gain2.gain.setValueAtTime(0.22, now + 0.09);
          gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

          osc1.connect(gain1);
          gain1.connect(ctx.destination);
          osc2.connect(gain2);
          gain2.connect(ctx.destination);

          osc1.start(now);
          osc1.stop(now + 0.4);
          osc2.start(now + 0.09);
          osc2.stop(now + 0.65);
          this.triggerHaptic([40, 60, 40]);
          break;
        }

        case 'error': {
          // Soft subtle error thud
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(260, now);
          osc.frequency.exponentialRampToValueAtTime(140, now + 0.2);

          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(now);
          osc.stop(now + 0.22);
          this.triggerHaptic([50, 40, 50]);
          break;
        }

        default:
          break;
      }
    }
  };

  window.ShareWebSound = SoundEngine;
})();
