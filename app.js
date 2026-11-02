(() => {
  "use strict";

  const FIRST_NOTE = 21;
  const LAST_NOTE = 108;
  const WHITE_WIDTH = 22;
  const WHITE_NOTES = new Set([0, 2, 4, 5, 7, 9, 11]);
  const NOTE_NAMES = ["До", "До♯", "Ре", "Ре♯", "Ми", "Фа", "Фа♯", "Соль", "Соль♯", "Ля", "Ля♯", "Си"];
  const els = Object.fromEntries([
    "song-title", "song-subtitle", "import-button", "midi-file", "empty-import", "empty-state", "falling-inner",
    "note-canvas", "keyboard", "keyboard-scroll", "falling-wrap", "falling-inner", "falling-caption", "listen-mode", "practice-mode", "play-button", "play-icon",
    "play-label", "restart-button", "stop-button", "position-current", "position-total", "progress-label",
    "progress-bar", "tempo-label", "tempo-pill", "speed-control", "speed-label", "range-start", "range-end",
    "loop-toggle", "microphone-button", "device-button", "connection-status"
  ].map(id => [id, document.getElementById(id)]));

  const state = {
    notes: [], groups: [], duration: 0, loaded: false, mode: "listen", hand: "both",
    playing: false, startTime: 0, elapsed: 0, currentGroup: 0, pendingNotes: new Set(),
    matchedNotes: new Set(), raf: 0, speed: 1, loop: false, audioContext: null,
    micStream: null, micFrame: 0, midiAccess: null, activeMidiInput: null, previousMicNote: null,
    wrongTimer: 0, keyElements: new Map()
  };
  const ctx = els["note-canvas"].getContext("2d");
  const keyboardWidth = (countWhiteKeys() * WHITE_WIDTH);

  function countWhiteKeys() {
    let count = 0;
    for (let note = FIRST_NOTE; note <= LAST_NOTE; note++) if (WHITE_NOTES.has(note % 12)) count++;
    return count;
  }

  function noteName(note) {
    return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
  }

  function renderKeyboard() {
    let whiteIndex = 0;
    const fragment = document.createDocumentFragment();
    for (let note = FIRST_NOTE; note <= LAST_NOTE; note++) {
      const pitchClass = note % 12;
      const key = document.createElement("button");
      key.type = "button";
      key.className = WHITE_NOTES.has(pitchClass) ? "white-key" : "black-key";
      key.dataset.note = String(note);
      key.setAttribute("aria-label", noteName(note));
      key.title = noteName(note);
      if (WHITE_NOTES.has(pitchClass)) {
        key.style.left = `${whiteIndex * WHITE_WIDTH}px`;
        key.style.width = `${WHITE_WIDTH}px`;
        if (pitchClass === 0 || note === FIRST_NOTE) {
          const label = document.createElement("span");
          label.className = "key-label";
          label.textContent = noteName(note);
          key.append(label);
        }
        whiteIndex++;
      } else {
        key.style.left = `${whiteIndex * WHITE_WIDTH - 7}px`;
        key.style.width = "14px";
        const label = document.createElement("span");
        label.className = "key-label";
        label.textContent = NOTE_NAMES[pitchClass].replace("♯", "#");
        key.append(label);
      }
      key.addEventListener("pointerdown", event => {
        event.preventDefault();
        key.classList.add("pressed");
        receiveNote(note, "tap");
      });
      els["keyboard-scroll"].addEventListener("scroll", () => {
        if (els["falling-wrap"].scrollLeft !== els["keyboard-scroll"].scrollLeft) {
          els["falling-wrap"].scrollLeft = els["keyboard-scroll"].scrollLeft;
        }
      });
      els["falling-wrap"].addEventListener("scroll", () => {
        if (els["keyboard-scroll"].scrollLeft !== els["falling-wrap"].scrollLeft) {
          els["keyboard-scroll"].scrollLeft = els["falling-wrap"].scrollLeft;
        }
      });
      key.addEventListener("pointerup", () => key.classList.remove("pressed"));
      key.addEventListener("pointerleave", () => key.classList.remove("pressed"));
      fragment.append(key);
      state.keyElements.set(note, key);
    }
    els.keyboard.style.width = `${keyboardWidth}px`;
    els.keyboard.append(fragment);
    resizeCanvas();
  }

  function resizeCanvas() {
    const wrap = els["falling-wrap"];
    const canvas = els["note-canvas"];
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, els.keyboard.scrollWidth);
    const height = wrap.clientHeight;
    els["falling-inner"].style.width = `${width}px`;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintNotes();
  }

  function parseMidi(buffer) {
    const data = new DataView(buffer);
    let offset = 0;
    const readText = length => {
      if (offset + length > data.byteLength) throw new Error("Повреждён MIDI-файл.");
      let text = "";
      for (let i = 0; i < length; i++) text += String.fromCharCode(data.getUint8(offset++));
      return text;
    };
    const readU32 = () => { const value = data.getUint32(offset); offset += 4; return value; };
    const readU16 = () => { const value = data.getUint16(offset); offset += 2; return value; };
    const readVar = end => {
      let value = 0, byte;
      do {
        if (offset >= end) throw new Error("Повреждён MIDI-файл.");
        byte = data.getUint8(offset++);
        value = (value << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      return value;
    };

    if (readText(4) !== "MThd") throw new Error("Это не MIDI-файл.");
    const headerLength = readU32();
    if (headerLength < 6 || offset + headerLength > data.byteLength) throw new Error("Повреждён заголовок MIDI-файла.");
    const format = readU16();
    const trackCount = readU16();
    const division = readU16();
    offset += headerLength - 6;
    if (format > 2) throw new Error("Этот формат MIDI не поддерживается.");
    if (division & 0x8000) throw new Error("MIDI с SMPTE-таймингом не поддерживается.");
    if (!division) throw new Error("В MIDI-файле отсутствует информация о темпе.");

    const events = [];
    const tempos = [{ tick: 0, micros: 500000 }];
    const tracks = [];
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      if (readText(4) !== "MTrk") throw new Error("Не удалось прочитать дорожку MIDI-файла.");
      const length = readU32();
      const end = offset + length;
      if (end > data.byteLength) throw new Error("Дорожка MIDI-файла обрезана.");
      let tick = 0, runningStatus = 0;
      const trackEvents = [];
      const active = new Map();
      while (offset < end) {
        tick += readVar(end);
        let status = data.getUint8(offset);
        if (status < 0x80) {
          if (!runningStatus) throw new Error("Неверная последовательность событий MIDI.");
          status = runningStatus;
        } else {
          offset++;
          if (status < 0xf0) runningStatus = status;
        }
        if (status === 0xff) {
          const type = data.getUint8(offset++);
          const metaLength = readVar(end);
          if (offset + metaLength > end) throw new Error("Повреждённое MIDI-событие.");
          if (type === 0x51 && metaLength === 3) tempos.push({ tick, micros: (data.getUint8(offset) << 16) | (data.getUint8(offset + 1) << 8) | data.getUint8(offset + 2) });
          offset += metaLength;
          if (type === 0x2f) break;
          continue;
        }
        if (status === 0xf0 || status === 0xf7) {
          offset += readVar(end);
          runningStatus = 0;
          continue;
        }
        const command = status >> 4;
        const channel = status & 0x0f;
        const first = data.getUint8(offset++);
        const second = command === 0xc || command === 0xd ? 0 : data.getUint8(offset++);
        if (command === 0x9 && second > 0) {
          const key = `${channel}:${first}`;
          if (!active.has(key)) active.set(key, []);
          active.get(key).push({ tick, pitch: first, velocity: second, channel });
        } else if (command === 0x8 || (command === 0x9 && second === 0)) {
          const key = `${channel}:${first}`;
          const queue = active.get(key);
          if (queue && queue.length) {
            const noteOn = queue.shift();
            trackEvents.push({ ...noteOn, endTick: tick, track: trackIndex });
          }
        }
      }
      tracks.push(trackEvents);
      offset = end;
    }

    const merged = format === 2 ? tracks[0] || [] : tracks.flat();
    if (!merged.length) throw new Error("В MIDI-файле не найдены ноты.");
    tempos.sort((a, b) => a.tick - b.tick);
    const uniqueTempos = tempos.filter((tempo, i) => i === 0 || tempo.tick !== tempos[i - 1].tick);
    function tickToSeconds(tick) {
      let seconds = 0, lastTick = 0, micros = 500000;
      for (const tempo of uniqueTempos) {
        if (tempo.tick > tick) break;
        seconds += ((tempo.tick - lastTick) * micros) / (division * 1000000);
        lastTick = tempo.tick;
        micros = tempo.micros;
      }
      return seconds + ((tick - lastTick) * micros) / (division * 1000000);
    }

    const notes = merged.map(note => ({
      pitch: note.pitch,
      start: tickToSeconds(note.tick),
      end: tickToSeconds(Math.max(note.endTick, note.tick + Math.max(1, division / 8))),
      hand: note.pitch < 60 ? "left" : "right",
      channel: note.channel,
      velocity: note.velocity
    })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const last = Math.max(...notes.map(note => note.end));
    const groups = [];
    for (const note of notes) {
      let group = groups[groups.length - 1];
      if (!group || note.start - group.start > 0.065) {
        group = { start: note.start, notes: [] };
        groups.push(group);
      }
      group.notes.push(note);
    }
    return { notes, groups, duration: last };
  }

  function showError(message) {
    els["connection-status"].textContent = message;
    els["connection-status"].classList.add("error");
  }

  async function loadMidi(file) {
    if (!file) return;
    try {
      const parsed = parseMidi(await file.arrayBuffer());
      stopPlayback();
      state.notes = parsed.notes;
      state.groups = parsed.groups;
      state.duration = parsed.duration;
      state.loaded = true;
      state.currentGroup = 0;
      state.elapsed = 0;
      state.pendingNotes.clear();
      state.matchedNotes.clear();
      els["song-title"].textContent = file.name.replace(/\.(midi?)$/i, "").replace(/[_-]+/g, " ") || "Моя песня";
      els["song-subtitle"].textContent = `${parsed.notes.length} нот · ${formatDuration(parsed.duration)} · MIDI-файл обработан в браузере`;
      els["empty-state"].hidden = true;
      els["falling-inner"].hidden = false;
      els["falling-caption"].hidden = false;
      els["position-total"].textContent = formatDuration(parsed.duration);
      els["range-start"].max = parsed.duration.toFixed(1);
      els["range-end"].max = parsed.duration.toFixed(1);
      els["range-end"].value = parsed.duration.toFixed(1);
      els["range-start"].disabled = false;
      els["range-end"].disabled = false;
      els["loop-toggle"].disabled = false;
      els["progress-label"].textContent = `${parsed.groups.length} нотных фраз`;
      els["tempo-label"].textContent = "MIDI загружен";
      els["tempo-pill"].classList.add("ready");
      els["connection-status"].classList.remove("error");
      els["connection-status"].textContent = state.mode === "practice"
        ? "Готово к практике. Нажми «Микрофон» или подключи MIDI-клавиатуру."
        : "Песня загружена. Включи режим «Играть самому», чтобы ноты ждали тебя.";
      paintNotes();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Не удалось прочитать MIDI-файл.");
    } finally {
      els["midi-file"].value = "";
    }
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function formatDuration(seconds) {
    return formatTime(Math.ceil(seconds || 0));
  }

  function visibleNotes() {
    return state.notes.filter(note => state.hand === "both" || note.hand === state.hand);
  }

  function paintNotes() {
    const width = els.keyboard.scrollWidth || keyboardWidth;
    const height = els["falling-wrap"].clientHeight;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const whitePos = new Map();
    let whiteIndex = 0;
    for (let note = FIRST_NOTE; note <= LAST_NOTE; note++) {
      if (WHITE_NOTES.has(note % 12)) whitePos.set(note, whiteIndex++ * WHITE_WIDTH);
    }
    const noteWidth = WHITE_WIDTH * 0.76;
    const hitY = height - 27;
    const windowSeconds = 4.2 / state.speed;
    const currentTime = state.playing ? state.elapsed : state.elapsed;
    const draw = visibleNotes();
    for (const note of draw) {
      const distance = note.start - currentTime;
      if (distance < -1.4 || distance > windowSeconds) continue;
      const keyLeft = whitePos.get(note.pitch) ?? ((whitePos.get(note.pitch - 1) ?? 0) + WHITE_WIDTH * 0.66);
      const center = keyLeft + (WHITE_NOTES.has(note.pitch % 12) ? WHITE_WIDTH / 2 : WHITE_WIDTH * 0.72);
      const y = hitY - (distance / windowSeconds) * (height - 44);
      const noteHeight = Math.max(9, Math.min(42, noteWidth * (0.65 + Math.min(note.end - note.start, 1))));
      const isCurrent = state.mode === "practice" && state.pendingNotes.has(note.pitch) && state.currentGroup < state.groups.length && note.start === state.groups[state.currentGroup].start;
      ctx.fillStyle = note.hand === "left" ? (isCurrent ? "#a3f0f3" : "#6bcbe0") : (isCurrent ? "#e4d6ff" : "#ad94f4");
      ctx.globalAlpha = distance < 0 ? Math.max(.18, 1 + distance / 1.4) : .93;
      ctx.beginPath();
      ctx.roundRect(center - noteWidth / 2, y - noteHeight, noteWidth, noteHeight, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (noteWidth > 13 && distance > -0.5 && distance < windowSeconds * 0.78) {
        ctx.fillStyle = note.hand === "left" ? "#14323d" : "#332953";
        ctx.font = "8px DM Sans, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(noteName(note.pitch), center, y - noteHeight / 2 + 3);
      }
    }
  }

  function setMode(mode) {
    state.mode = mode;
    if (state.playing && mode === "practice") {
      state.currentGroup = state.groups.findIndex(group => group.start >= state.elapsed);
      if (state.currentGroup < 0) state.currentGroup = state.groups.length;
      state.matchedNotes.clear();
    }
    els["listen-mode"].classList.toggle("active", mode === "listen");
    els["practice-mode"].classList.toggle("active", mode === "practice");
    els["listen-mode"].setAttribute("aria-pressed", String(mode === "listen"));
    els["practice-mode"].setAttribute("aria-pressed", String(mode === "practice"));
    if (mode === "practice") {
      els["connection-status"].textContent = state.loaded
        ? "Ноты будут ждать правильного звука с твоего инструмента."
        : "Сначала загрузи MIDI-файл, затем подключи микрофон или MIDI-клавиатуру.";
    } else {
      els["connection-status"].textContent = "В режиме прослушивания ноты идут по времени без ожидания.";
      state.matchedNotes.clear();
      clearExpectedKeys();
    }
    paintNotes();
  }

  function rangeStart() {
    const value = Number(els["range-start"].value);
    return Number.isFinite(value) ? Math.min(state.duration, Math.max(0, value)) : 0;
  }
  function rangeEnd() {
    const raw = els["range-end"].value.trim();
    const value = raw === "" ? state.duration : Number(raw);
    return Number.isFinite(value) ? Math.max(rangeStart(), Math.min(state.duration, value)) : state.duration;
  }

  function startPlayback() {
    if (!state.loaded) {
      showError("Сначала выбери MIDI-файл — без него нечего проигрывать.");
      return;
    }
    stopPlayback();
    state.playing = true;
    const start = rangeStart();
    state.elapsed = start;
    state.startTime = performance.now() - start * 1000 / state.speed;
    state.currentGroup = state.groups.findIndex(group => group.start >= start);
    if (state.currentGroup < 0) state.currentGroup = state.groups.length;
    state.matchedNotes.clear();
    els["play-icon"].textContent = "Ⅱ";
    els["play-label"].textContent = state.mode === "practice" ? "Пауза" : "Пауза";
    els["tempo-label"].textContent = state.mode === "practice" ? "Жду твою ноту" : "Играет";
    state.raf = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    els["play-icon"].textContent = "▶";
    els["play-label"].textContent = "Начать";
    if (state.loaded) els["tempo-label"].textContent = "MIDI загружен";
    clearExpectedKeys();
    paintNotes();
  }

  function tick(now) {
    if (!state.playing) return;
    if (state.mode === "listen") {
      state.elapsed = (now - state.startTime) * state.speed / 1000;
    } else if (state.currentGroup < state.groups.length) {
      state.elapsed = Math.max(0, state.groups[state.currentGroup].start - 0.65, state.elapsed);
      showExpectedGroup();
    } else {
      state.elapsed = rangeEnd();
    }

    const end = rangeEnd();
    if (state.elapsed >= end || (state.currentGroup >= state.groups.length && state.mode === "practice")) {
      if (state.loop && end > rangeStart()) {
        state.elapsed = rangeStart();
        state.startTime = now - state.elapsed * 1000 / state.speed;
        state.currentGroup = state.groups.findIndex(group => group.start >= state.elapsed);
        state.matchedNotes.clear();
        clearExpectedKeys();
      } else {
        state.elapsed = end;
        stopPlayback();
        return;
      }
    }
    const progress = state.duration ? Math.min(100, state.elapsed / state.duration * 100) : 0;
    els["progress-bar"].style.width = `${progress}%`;
    els["position-current"].textContent = formatTime(state.elapsed);
    paintNotes();
    state.raf = requestAnimationFrame(tick);
  }

  function showExpectedGroup() {
    clearExpectedKeys();
    const group = state.groups[state.currentGroup];
    if (!group) return;
    state.pendingNotes = new Set(group.notes
      .filter(note => state.hand === "both" || note.hand === state.hand)
      .map(note => note.pitch));
    for (const note of state.pendingNotes) {
      const element = state.keyElements.get(note);
      if (element && !state.matchedNotes.has(note)) element.classList.add("expected");
    }
    if (!state.pendingNotes.size) advanceGroup();
  }

  function clearExpectedKeys() {
    for (const key of state.keyElements.values()) key.classList.remove("expected");
  }

  function advanceGroup() {
    state.matchedNotes.clear();
    state.currentGroup++;
    if (state.currentGroup < state.groups.length) {
      const next = state.groups[state.currentGroup];
      state.elapsed = Math.max(0, next.start - 0.65, state.elapsed);
    }
    els["tempo-label"].textContent = "Верно! Продолжай";
    window.setTimeout(() => {
      if (state.playing && state.mode === "practice") els["tempo-label"].textContent = "Жду твою ноту";
    }, 750);
  }

  function receiveNote(note, source) {
    if (!state.playing || state.mode !== "practice" || !state.loaded) {
      if (source !== "mic") return;
      return;
    }
    const group = state.groups[state.currentGroup];
    if (!group) return;
    const expected = [...new Set(group.notes.filter(item => state.hand === "both" || item.hand === state.hand).map(item => item.pitch))];
    if (!expected.length) { advanceGroup(); return; }
    if (!expected.includes(note)) {
      els["tempo-label"].textContent = `Попробуй ещё · ${noteName(expected[0])}`;
      els["tempo-pill"].classList.add("wrong");
      window.clearTimeout(state.wrongTimer);
      state.wrongTimer = window.setTimeout(() => {
        els["tempo-pill"].classList.remove("wrong");
        if (state.playing) els["tempo-label"].textContent = "Жду твою ноту";
      }, 900);
      return;
    }
    if (state.matchedNotes.has(note)) return;
    state.matchedNotes.add(note);
    const key = state.keyElements.get(note);
    if (key) {
      key.classList.add("pressed");
      window.setTimeout(() => key.classList.remove("pressed"), 180);
      key.classList.remove("expected");
    }
    if (expected.every(pitch => state.matchedNotes.has(pitch))) advanceGroup();
  }

  async function connectMicrophone() {
    if (state.micStream) {
      state.micStream.getTracks().forEach(track => track.stop());
      state.micStream = null;
      cancelAnimationFrame(state.micFrame);
      state.previousMicNote = null;
      els["microphone-button"].classList.remove("active");
      els["connection-status"].textContent = "Микрофон отключён.";
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("Браузер не поддерживает микрофон. Открой приложение по HTTPS или подключи MIDI-клавиатуру.");
      return;
    }
    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      state.audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
      await state.audioContext.resume();
      const source = state.audioContext.createMediaStreamSource(state.micStream);
      const analyser = state.audioContext.createAnalyser();
      analyser.fftSize = 4096;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      els["microphone-button"].classList.add("active");
      els["connection-status"].classList.remove("error");
      els["connection-status"].textContent = state.mode === "practice"
        ? "Микрофон слушает. Играй по одной ноте рядом с устройством."
        : "Микрофон включён. Для проверки нот выбери «Играть самому».";
      const listen = () => {
        if (!state.micStream) return;
        analyser.getFloatTimeDomainData(buffer);
        const pitch = detectPitch(buffer, state.audioContext.sampleRate);
        if (pitch) {
          const midiNote = Math.round(69 + 12 * Math.log2(pitch / 440));
          if (midiNote !== state.previousMicNote) {
            state.previousMicNote = midiNote;
            receiveNote(midiNote, "mic");
          }
        } else {
          state.previousMicNote = null;
        }
        state.micFrame = requestAnimationFrame(listen);
      };
      listen();
    } catch (error) {
      state.micStream = null;
      showError(error && error.name === "NotAllowedError"
        ? "Нет доступа к микрофону. Разреши его в настройках браузера или подключи MIDI-клавиатуру."
        : "Не удалось подключить микрофон. Проверь разрешения браузера.");
    }
  }

  function detectPitch(samples, sampleRate) {
    const size = samples.length;
    let rms = 0;
    for (let i = 0; i < size; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / size);
    if (rms < 0.012) return null;
    const minLag = Math.floor(sampleRate / 1000);
    const maxLag = Math.min(Math.floor(sampleRate / 45), size / 2);
    let bestLag = 0, bestCorrelation = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let correlation = 0;
      for (let i = 0; i < size - lag; i++) correlation += samples[i] * samples[i + lag];
      correlation /= size - lag;
      if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag; }
    }
    if (!bestLag || bestCorrelation < 0.0025) return null;
    return sampleRate / bestLag;
  }

  async function connectMidi() {
    if (!navigator.requestMIDIAccess) {
      showError("Этот браузер не поддерживает Web MIDI. Попробуй Chrome на компьютере или микрофон.");
      return;
    }
    try {
      state.midiAccess = await navigator.requestMIDIAccess();
      const inputs = Array.from(state.midiAccess.inputs.values());
      if (!inputs.length) {
        showError("MIDI-клавиатура не найдена. Подключи её и попробуй снова, либо используй микрофон.");
        return;
      }
      if (state.activeMidiInput) state.activeMidiInput.onmidimessage = null;
      state.activeMidiInput = inputs[0];
      state.activeMidiInput.onmidimessage = event => {
        const [status, pitch, velocity] = event.data;
        if ((status & 0xf0) === 0x90 && velocity > 0) receiveNote(pitch, "midi");
      };
      els["device-button"].classList.add("active");
      els["connection-status"].classList.remove("error");
      els["connection-status"].textContent = `Подключена MIDI-клавиатура: ${state.activeMidiInput.name || "инструмент"}.`;
      state.midiAccess.onstatechange = () => {
        if (state.activeMidiInput && state.activeMidiInput.state !== "connected") {
          els["device-button"].classList.remove("active");
          els["connection-status"].textContent = "MIDI-клавиатура отключена.";
          state.activeMidiInput = null;
        }
      };
    } catch (error) {
      showError(error && error.name === "SecurityError"
        ? "Web MIDI доступен в поддерживаемом браузере по HTTPS."
        : "Не удалось подключить MIDI-клавиатуру. Проверь разрешение браузера.");
    }
  }

  function updateHand(hand) {
    state.hand = hand;
    document.querySelectorAll(".hand-button").forEach(button => {
      const active = button.dataset.hand === hand;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    state.currentGroup = state.groups.findIndex((group, index) => index >= Math.max(0, state.currentGroup) &&
      group.notes.some(note => hand === "both" || note.hand === hand));
    if (state.currentGroup < 0) state.currentGroup = state.groups.length;
    state.matchedNotes.clear();
    paintNotes();
  }

  els["import-button"].addEventListener("click", () => els["midi-file"].click());
  els["empty-import"].addEventListener("click", () => els["midi-file"].click());
  els["midi-file"].addEventListener("change", event => loadMidi(event.target.files[0]));
  els["listen-mode"].addEventListener("click", () => setMode("listen"));
  els["practice-mode"].addEventListener("click", () => setMode("practice"));
  document.querySelectorAll(".hand-button").forEach(button => button.addEventListener("click", () => updateHand(button.dataset.hand)));
  els["play-button"].addEventListener("click", () => state.playing ? stopPlayback() : startPlayback());
  els["restart-button"].addEventListener("click", () => {
    if (state.loaded) els["range-start"].value = "0";
    state.elapsed = 0;
    state.currentGroup = 0;
    state.matchedNotes.clear();
    if (state.playing) startPlayback();
    else {
      els["position-current"].textContent = "0:00";
      els["progress-bar"].style.width = "0%";
      paintNotes();
    }
  });
  els["stop-button"].addEventListener("click", stopPlayback);
  els["speed-control"].addEventListener("input", event => {
    state.speed = Number(event.target.value);
    els["speed-label"].textContent = `${state.speed.toFixed(2).replace(/0$/, "").replace(/\.$/, "")}×`;
    if (state.playing && state.mode === "listen") state.startTime = performance.now() - state.elapsed * 1000 / state.speed;
    paintNotes();
  });
  els["range-start"].addEventListener("change", () => {
    const start = Math.min(Number(els["range-start"].value) || 0, Number(els["range-end"].value) || state.duration);
    els["range-start"].value = String(start);
    if (state.elapsed < start) state.elapsed = start;
  });
  els["range-end"].addEventListener("change", () => {
    const raw = els["range-end"].value.trim();
    const value = raw === "" ? state.duration : Number(raw);
    const end = Math.max(rangeStart(), Math.min(state.duration, Number.isFinite(value) ? value : state.duration));
    els["range-end"].value = String(end);
  });
  els["loop-toggle"].addEventListener("change", event => { state.loop = event.target.checked; });
  els["microphone-button"].addEventListener("click", connectMicrophone);
  els["device-button"].addEventListener("click", connectMidi);
  els["keyboard-scroll"].addEventListener("keydown", event => {
    if (event.key === "ArrowRight") els["keyboard-scroll"].scrollLeft += 80;
    if (event.key === "ArrowLeft") els["keyboard-scroll"].scrollLeft -= 80;
  });
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("beforeunload", () => {
    if (state.micStream) state.micStream.getTracks().forEach(track => track.stop());
  });
  renderKeyboard();
})();
