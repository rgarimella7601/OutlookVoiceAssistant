/* AI Voice Assistant — Outlook task pane
 * Speech-to-text: OpenAI /v1/audio/transcriptions (key entered by the user in Settings).
 * Cleanup: built-in rules (fillers, repeats, capitalization, punctuation). No other AI.
 * Text enters the email ONLY when the user clicks "Insert into Email".
 */
(function () {
  'use strict';

  var API = 'https://api.openai.com/v1';
  var LS_SETTINGS = 'aiva.settings.v1';
  var SS_DRAFT = 'aiva.draft';
  var SS_RELOADED = 'aiva.micReload';

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    phase: 'idle',            // idle | permission | recording | paused | finalizing | review | denied
    inOutlook: false,
    settings: { apiKey: '', model: 'gpt-4o-mini-transcribe', remember: true },
    // capture
    stream: null, ctx: null, analyser: null, buf: null, seg: null, vadTimer: null, noise: 0.005, speaking: false,
    // clock
    elapsedMs: 0, clock: null, lastTick: 0,
    // transcription
    queue: Promise.resolve(), pending: 0, failed: [], errorKind: null, liveText: '',
    // editor
    userEdited: false, lastInserted: ''
  };

  /* ---------- storage (always guarded) ---------- */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function ssDel(k) { try { window.sessionStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function loadSettings() {
    try {
      var raw = lsGet(LS_SETTINGS);
      if (raw) {
        var o = JSON.parse(raw);
        S.settings.apiKey = o.apiKey || '';
        S.settings.model = o.model || S.settings.model;
        S.settings.remember = o.remember !== false;
      }
    } catch (e) { /* ignore */ }
    var mem = ssGet('aiva.sessionKey');
    if (!S.settings.apiKey && mem) S.settings.apiKey = mem;
  }
  function saveSettings() {
    S.settings.apiKey = $('apiKey').value.trim();
    S.settings.model = $('model').value;
    S.settings.remember = $('rememberKey').checked;
    if (S.settings.remember) {
      lsSet(LS_SETTINGS, JSON.stringify(S.settings));
      ssDel('aiva.sessionKey');
    } else {
      lsSet(LS_SETTINGS, JSON.stringify({ apiKey: '', model: S.settings.model, remember: false }));
      ssSet('aiva.sessionKey', S.settings.apiKey);
    }
  }

  /* ---------- UI helpers ---------- */
  function show(el, on) { el.hidden = !on; }

  function showAlert(tone, title, body, actionLabel, action) {
    var a = $('alert');
    a.className = 'alert ' + tone;
    $('alertTitle').textContent = title;
    $('alertBody').textContent = body || '';
    var btn = $('alertAction');
    if (actionLabel) {
      btn.textContent = actionLabel;
      btn.onclick = action;
      show(btn, true);
    } else {
      btn.onclick = null;
      show(btn, false);
    }
    show(a, true);
  }
  function clearAlert() { show($('alert'), false); S.errorKind = null; }

  function showNotice(text, canRestore) {
    $('noticeText').textContent = text;
    show($('btnRestore'), !!canRestore);
    show($('notice'), true);
  }
  function hideNotice() { show($('notice'), false); }

  function setPhase(p) { S.phase = p; render(); }

  function fmt(ms) {
    var s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function wordCount(t) { t = t.trim(); return t ? t.split(/\s+/).length : 0; }

  function render() {
    var p = S.phase;
    var draft = $('draft').value;
    var has = draft.trim().length > 0;
    var rec = p === 'recording', paused = p === 'paused', fin = p === 'finalizing';

    // status line
    var dot = 'dot-idle', txt = 'Ready to dictate', cls = '';
    if (p === 'permission') { dot = 'dot-busy'; txt = 'Waiting for microphone permission…'; }
    else if (rec) { dot = 'dot-rec'; txt = 'Recording'; cls = 'st-rec'; }
    else if (paused) { dot = 'dot-paused'; txt = 'Paused — mic off'; cls = 'st-paused'; }
    else if (fin) { dot = 'dot-busy'; txt = 'Finishing up — transcribing last phrase…'; }
    else if (p === 'review') { dot = 'dot-ok'; txt = 'Done — review and edit, then insert'; }
    else if (p === 'denied') { dot = 'dot-err'; txt = 'Microphone blocked'; cls = 'st-err'; }
    $('statusDot').className = 'dot ' + dot;
    $('statusText').className = 'status-text ' + cls;
    $('statusText').textContent = txt;
    show($('level'), rec);
    show($('elapsed'), rec || paused || p === 'review');
    $('elapsed').textContent = fmt(S.elapsedMs);

    // controls
    var bs = $('btnStart');
    show(bs, !(rec || paused || fin));
    bs.disabled = p === 'permission';
    $('startLabel').textContent = p === 'permission' ? 'Please wait…'
      : p === 'denied' ? 'Try again'
      : (has || S.lastInserted) ? 'Record more' : 'Start recording';
    show($('btnPause'), rec);
    show($('btnResume'), paused);
    show($('btnStop'), rec || paused);

    // live strip
    show($('live'), rec || paused || fin || S.pending > 0);
    $('livePending').textContent = S.pending > 0
      ? '· transcribing ' + S.pending + (S.pending === 1 ? ' phrase…' : ' phrases…') : '';
    $('liveText').textContent = S.liveText
      || (rec ? (S.speaking ? 'Listening… (hearing you)' : 'Listening…')
        : paused ? 'Paused.' : 'Working…');

    // editor + insert
    $('wordCount').textContent = wordCount(draft) + ' words · editable';
    show($('editedNote'), S.userEdited && (rec || paused));
    var canInsert = has && S.pending === 0 && !(rec || fin || p === 'permission');
    $('btnInsert').disabled = !canInsert;
    var hint = '';
    if (!canInsert) {
      if (rec) hint = 'Pause or stop recording to insert.';
      else if (S.pending > 0 || fin) hint = 'Finishing transcription…';
      else if (!has) hint = 'Nothing to insert yet — start recording.';
      else hint = 'One moment…';
    } else if (!S.inOutlook) {
      hint = 'Open this pane from an Outlook email to insert.';
    }
    $('insertHint').textContent = hint;
    show($('insertHint'), !!hint);
    show($('btnClear'), has && !fin);
  }

  /* ---------- clock ---------- */
  function startClock() {
    stopClock();
    S.lastTick = performance.now();
    S.clock = setInterval(function () {
      var now = performance.now();
      S.elapsedMs += now - S.lastTick;
      S.lastTick = now;
      $('elapsed').textContent = fmt(S.elapsedMs);
    }, 250);
  }
  function stopClock() { if (S.clock) { clearInterval(S.clock); S.clock = null; } }

  /* ---------- microphone permission (new Outlook / Outlook on the web) ---------- */
  function ensureDevicePermission() {
    return new Promise(function (resolve) {
      try {
        if (!(window.Office && Office.devicePermission && Office.devicePermission.requestPermissionsAsync &&
              Office.context && Office.context.mailbox)) { resolve('ok'); return; }
        Office.devicePermission.requestPermissionsAsync([Office.DevicePermissionType.microphone], function (r) {
          if (r.status === Office.AsyncResultStatus.Failed) {
            var m = ((r.error && r.error.message) || '').toLowerCase();
            resolve(m.indexOf('denied') > -1 ? 'denied' : 'ok'); // unsupported host -> let getUserMedia decide
          } else {
            resolve(r.value ? 'reload' : 'ok');
          }
        });
      } catch (e) { resolve('ok'); }
    });
  }

  /* ---------- capture + voice activity segmentation ---------- */
  function pickMime() {
    var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (var i = 0; i < c.length; i++) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) { /* ignore */ }
    }
    return '';
  }

  function newSegment() {
    var mime = pickMime();
    var rec = mime ? new MediaRecorder(S.stream, { mimeType: mime }) : new MediaRecorder(S.stream);
    var seg = { rec: rec, chunks: [], start: performance.now(), speechMs: 0, hadSpeech: false, lastVoice: 0,
                mime: rec.mimeType || mime || 'audio/webm', keep: false, done: null };
    rec.ondataavailable = function (e) { if (e.data && e.data.size) seg.chunks.push(e.data); };
    rec.onstop = function () {
      if (seg.keep && seg.chunks.length) {
        enqueue({ blob: new Blob(seg.chunks, { type: seg.mime }), mime: seg.mime, speechMs: seg.speechMs });
      }
      if (seg.done) seg.done();
    };
    rec.start();
    S.seg = seg;
  }

  function stopSeg(seg, keep) {
    return new Promise(function (resolve) {
      if (!seg) { resolve(); return; }
      seg.keep = !!keep && seg.hadSpeech && seg.speechMs >= 250;
      seg.done = resolve;
      try { if (seg.rec.state !== 'inactive') seg.rec.stop(); else resolve(); } catch (e) { resolve(); }
    });
  }

  function cut(keep) {
    var old = S.seg;
    newSegment();          // start the next recorder first so no audio is lost
    stopSeg(old, keep);
  }

  function updateLevel(x) {
    var bars = $('level').children;
    var shape = [0.55, 0.85, 1, 0.8, 0.5];
    for (var i = 0; i < bars.length; i++) {
      var v = Math.max(0.15, Math.min(1, x * shape[i] * (0.8 + Math.random() * 0.4)));
      bars[i].style.transform = 'scaleY(' + v.toFixed(2) + ')';
    }
  }

  function vadTick() {
    if (!S.analyser || !S.seg) return;
    S.analyser.getFloatTimeDomainData(S.buf);
    var sum = 0;
    for (var i = 0; i < S.buf.length; i++) sum += S.buf[i] * S.buf[i];
    var rms = Math.sqrt(sum / S.buf.length);
    // adaptive noise floor: falls quickly, rises slowly
    if (rms < S.noise * 1.5) S.noise = S.noise * 0.95 + rms * 0.05;
    else S.noise = S.noise * 0.998 + rms * 0.002;
    var thr = Math.max(0.012, S.noise * 2.5);
    var now = performance.now();
    var seg = S.seg;
    var speaking = rms > thr;
    if (speaking) { seg.hadSpeech = true; seg.speechMs += 50; seg.lastVoice = now; }
    if (speaking !== S.speaking) { S.speaking = speaking; if (!S.liveText) render(); }
    updateLevel(rms / thr);
    var dur = now - seg.start;
    if (seg.hadSpeech && !speaking && now - seg.lastVoice > 700 && dur > 1200) cut(true);   // phrase boundary
    else if (dur > 20000) cut(true);                                                        // long run-on
    else if (!seg.hadSpeech && dur > 8000) cut(false);                                      // drop silence
  }

  function startCapture() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (stream) {
      S.stream = stream;
      var AC = window.AudioContext || window.webkitAudioContext;
      S.ctx = new AC();
      var src = S.ctx.createMediaStreamSource(stream);
      S.analyser = S.ctx.createAnalyser();
      S.analyser.fftSize = 1024;
      src.connect(S.analyser);
      S.buf = new Float32Array(S.analyser.fftSize);
      S.speaking = false;
      newSegment();
      S.vadTimer = setInterval(vadTick, 50);
    });
  }

  function stopCapture(keep) {
    if (S.vadTimer) { clearInterval(S.vadTimer); S.vadTimer = null; }
    var seg = S.seg; S.seg = null; S.speaking = false;
    return stopSeg(seg, keep).then(function () {
      if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
      if (S.ctx) { try { S.ctx.close(); } catch (e) { /* ignore */ } S.ctx = null; }
      S.analyser = null;
    });
  }

  /* ---------- transcription queue (strict order) ---------- */
  function enqueue(job) {
    S.pending++;
    render();
    S.queue = S.queue.then(function () { return runJob(job); }).catch(function () { /* keep chain alive */ });
  }

  function runJob(job) {
    if (S.errorKind) {            // a previous phrase failed: hold this one so order is kept
      S.failed.push(job);
      S.pending--; render();
      return Promise.resolve();
    }
    return transcribe(job, false).catch(function (err) {
      if (err && err.kind === 'request' && !job.noStream && S.settings.model !== 'whisper-1') {
        job.noStream = true;       // fall back to non-streaming once
        return transcribe(job, true);
      }
      throw err;
    }).then(function (text) {
      addText(text, job);
    }).catch(function (err) {
      S.failed.push(job);
      onTranscribeError(err);
    }).then(function () {
      S.pending--; S.liveText = ''; render();
    });
  }

  function mkErr(kind, msg, status) { var e = new Error(msg || kind); e.kind = kind; e.status = status; return e; }

  function transcribe(job, noStream) {
    var model = S.settings.model;
    var ext = job.mime.indexOf('mp4') > -1 ? 'mp4' : job.mime.indexOf('ogg') > -1 ? 'ogg' : 'webm';
    var fd = new FormData();
    fd.append('file', job.blob, 'speech.' + ext);
    fd.append('model', model);
    fd.append('language', 'en');
    fd.append('response_format', 'json');
    var context = $('draft').value.slice(-300).trim();
    if (context) fd.append('prompt', context);
    var streaming = model !== 'whisper-1' && !noStream && !job.noStream;
    if (streaming) fd.append('stream', 'true');

    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 45000);

    return fetch(API + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + S.settings.apiKey },
      body: fd,
      signal: ctrl.signal
    }).catch(function (e) {
      throw mkErr(e && e.name === 'AbortError' ? 'timeout' : 'network');
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          var msg = (j && j.error && j.error.message) || ('HTTP ' + res.status);
          var kind = res.status === 401 ? 'auth' : res.status === 429 ? 'quota' : res.status >= 500 ? 'server' : 'request';
          throw mkErr(kind, msg, res.status);
        });
      }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('text/event-stream') > -1 && res.body && res.body.getReader) {
        return readStream(res.body.getReader());
      }
      return res.json().then(function (j) { return (j && j.text) || ''; });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw mkErr('timeout');
      throw e;
    }).then(function (t) { clearTimeout(to); return t; }, function (e) { clearTimeout(to); throw e; });
  }

  function readStream(reader) {
    var dec = new TextDecoder();
    var buf = '', partial = '', finalText = null;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return finalText != null ? finalText : partial;
        buf += dec.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.indexOf('data:') !== 0) continue;
          var data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          var ev; try { ev = JSON.parse(data); } catch (e) { continue; }
          if (ev.type === 'transcript.text.delta') {
            partial += ev.delta || '';
            S.liveText = partial; render();
          } else if (ev.type === 'transcript.text.done') {
            finalText = ev.text || partial;
          }
        }
        return pump();
      });
    }
    return pump();
  }

  /* ---------- cleanup rules (no AI) ---------- */
  var KEEP_DOUBLE = { had: 1, that: 1, is: 1 };
  function polish(t) {
    if (!t) return '';
    var s = ' ' + String(t).replace(/\s+/g, ' ').trim() + ' ';
    // fillers: um, umm, uh, uhh, uhm, erm, ah, ahh, hmm, mm, mhm
    s = s.replace(/(^|[\s,.;!?])(?:u+m+|u+h+m*|e+r+m+|a+h+|h+m+|m+h*m+)(?=[\s,.;!?]|$)[,.]?/gi, '$1');
    // stutter repeats: "the the" -> "the"
    s = s.replace(/\b(\w+)(?:\s+\1\b)+/gi, function (m, w) { return KEEP_DOUBLE[w.toLowerCase()] ? m : w; });
    s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
    s = s.replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/[,;:]\s*([.!?])/g, '$1');
    s = s.replace(/^\s*[,.;:]+\s*/, '').trim();
    // pronoun I
    s = s.replace(/\bi\b(?!['’]?[a-z])/g, 'I').replace(/\bi(['’])(m|ll|ve|d)\b/gi, function (m, a, b) { return 'I' + a + b.toLowerCase(); });
    // sentence capitals
    s = s.replace(/(^|[.!?]\s+)([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
    if (s && !/[.!?…"”')\]]$/.test(s)) s += '.';
    return s;
  }

  var HALLUCINATIONS = /^(thank you\.?|thanks for watching[.!]?|you\.?|bye\.?)$/i;

  function addText(raw, job) {
    var text = polish(raw);
    if (!text) return;
    if (HALLUCINATIONS.test(text) && job && job.speechMs < 700) return;
    var ta = $('draft');
    var focused = document.activeElement === ta;
    var a = ta.selectionStart, b = ta.selectionEnd;
    var base = ta.value.replace(/\s+$/, '');
    ta.value = base ? base + (/\n$/.test(ta.value) ? '' : ' ') + text : text;   // append only, never overwrite
    if (focused) { try { ta.setSelectionRange(a, b); } catch (e) { /* ignore */ } }
    persistDraft();
  }

  function onTranscribeError(err) {
    var kind = (err && err.kind) || 'server';
    S.errorKind = kind;
    var pauseIt = S.phase === 'recording' ? pauseCapture() : Promise.resolve();
    pauseIt.then(function () {
      var title, body;
      if (kind === 'network' || kind === 'timeout') {
        title = kind === 'timeout' ? 'Transcription timed out — recording paused' : 'Connection lost — recording paused';
        body = 'Your text is safe and nothing was inserted. Check your connection, then select Retry.';
      } else if (kind === 'auth') {
        title = 'OpenAI rejected the API key';
        body = 'Open Settings (gear icon), paste a valid key, save, then select Retry.\n(' + err.message + ')';
      } else if (kind === 'quota') {
        title = 'OpenAI usage limit reached';
        body = 'Your OpenAI account is out of credit or rate-limited. Check billing at platform.openai.com, then select Retry.\n(' + err.message + ')';
      } else {
        title = 'The transcription service had a problem';
        body = 'Your text is safe. Select Retry to send the held phrases again.\n(' + err.message + ')';
      }
      showAlert(kind === 'auth' ? 'err' : 'warn', title, body, 'Retry', retryFailed);
    });
  }

  function retryFailed() {
    clearAlert();
    var jobs = S.failed; S.failed = [];
    jobs.forEach(function (j) { enqueue(j); });
    render();
  }

  /* ---------- actions ---------- */
  function persistDraft() { ssSet(SS_DRAFT, $('draft').value); }

  function start() {
    if (S.phase === 'permission' || S.phase === 'recording' || S.phase === 'finalizing') return;
    if (!S.settings.apiKey) {
      openSettings(true);
      showAlert('info', 'Add your OpenAI API key first', 'Paste your key in Settings and select Save, then start recording.');
      return;
    }
    clearAlert(); hideNotice();
    setPhase('permission');
    ensureDevicePermission().then(function (r) {
      if (r === 'reload') {
        persistDraft(); ssSet(SS_RELOADED, '1');
        window.location.reload();
        return;
      }
      if (r === 'denied') { showDenied(); return; }
      startCapture().then(function () {
        setPhase('recording'); startClock();
      }).catch(function (e) {
        var n = e && e.name;
        if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') showDenied();
        else if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
          setPhase('idle');
          showAlert('err', 'No microphone found', 'Connect a microphone or headset, then select Start recording.');
        } else if (n === 'NotReadableError') {
          setPhase('idle');
          showAlert('err', 'Microphone is busy', 'Another app (for example, a Teams call) may be using the microphone. Close it and try again.');
        } else {
          setPhase('idle');
          showAlert('err', 'Could not start the microphone', String((e && e.message) || e));
        }
      });
    });
  }

  function showDenied() {
    setPhase('denied');
    showAlert('err', 'We can’t hear you yet',
      'Microphone access was denied.\n' +
      '1. Select Try again and choose Allow when Outlook asks.\n' +
      '2. If you are not asked, open Windows Settings › Privacy & security › Microphone and turn on microphone access for desktop apps.\n' +
      '3. Then select Try again.',
      'Try again', start);
  }

  function pauseCapture() {
    stopClock();
    return stopCapture(true).then(function () { setPhase('paused'); });
  }
  function pause() { if (S.phase === 'recording') pauseCapture(); }

  function resume() {
    if (S.phase !== 'paused') return;
    if (S.errorKind) { retryFailed(); }
    clearAlert();
    startCapture().then(function () { setPhase('recording'); startClock(); })
      .catch(function () { showDenied(); });
  }

  function stop() {
    if (!(S.phase === 'recording' || S.phase === 'paused')) return;
    stopClock();
    setPhase('finalizing');
    stopCapture(true).then(function () { return S.queue; }).then(function () {
      setPhase(S.errorKind ? 'paused' : 'review');
    });
  }

  function toHtml(text) {
    var esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(/\r?\n/g, '<br>');
  }

  function insert() {
    var text = $('draft').value.trim();
    if (!text) return;
    if (!S.inOutlook || !Office.context.mailbox || !Office.context.mailbox.item) {
      showAlert('warn', 'Open an email to insert', 'Open a new email or reply in Outlook, then open AI Voice Assistant from the ribbon.');
      return;
    }
    var item = Office.context.mailbox.item;
    $('btnInsert').disabled = true;
    item.body.getTypeAsync(function (r) {
      var isHtml = r.status === Office.AsyncResultStatus.Succeeded && r.value === Office.CoercionType.Html;
      item.body.setSelectedDataAsync(isHtml ? toHtml(text) : text,
        { coercionType: isHtml ? Office.CoercionType.Html : Office.CoercionType.Text },
        function (res) {
          if (res.status === Office.AsyncResultStatus.Failed) {
            showAlert('err', 'Couldn’t insert the text',
              'Your text is still here. Click inside the message body, then select Insert into Email again.\n(' +
              ((res.error && res.error.message) || 'unknown error') + ')');
            render();
            return;
          }
          S.lastInserted = text;
          $('draft').value = '';
          S.userEdited = false;
          persistDraft();
          if (S.phase === 'review' || S.phase === 'denied') S.phase = 'idle';
          showNotice('Inserted at your cursor. The email was not sent. To undo, press Ctrl+Z in the message.', true);
          render();
        });
    });
  }

  function restoreInserted() {
    if (!S.lastInserted) return;
    var ta = $('draft');
    ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + ' ' + S.lastInserted : S.lastInserted;
    hideNotice(); persistDraft(); render();
  }

  function clearDraft() {
    $('draft').value = ''; S.userEdited = false; persistDraft(); hideNotice();
    if (S.phase === 'review') S.phase = 'idle';
    render();
  }

  /* ---------- settings panel ---------- */
  function openSettings(force) {
    var panel = $('settings');
    var open = force === true ? true : panel.hidden;
    panel.hidden = !open;
    $('btnSettings').setAttribute('aria-expanded', String(open));
    if (open) {
      $('apiKey').value = S.settings.apiKey;
      $('model').value = S.settings.model;
      $('rememberKey').checked = S.settings.remember;
      $('settingsMsg').textContent = '';
      $('apiKey').focus();
    }
  }

  function testKey() {
    var key = $('apiKey').value.trim();
    var msg = $('settingsMsg');
    if (!key) { msg.textContent = 'Paste a key first.'; return; }
    msg.textContent = 'Checking…';
    fetch(API + '/models', { headers: { Authorization: 'Bearer ' + key } }).then(function (r) {
      msg.textContent = r.ok ? 'Key works.' : (r.status === 401 ? 'Key was rejected (401).' : 'OpenAI returned ' + r.status + '.');
    }).catch(function () { msg.textContent = 'Could not reach api.openai.com. Check your network or firewall.'; });
  }

  /* ---------- init ---------- */
  function init() {
    loadSettings();
    var saved = ssGet(SS_DRAFT);
    if (saved) $('draft').value = saved;

    $('btnStart').addEventListener('click', start);
    $('btnPause').addEventListener('click', pause);
    $('btnResume').addEventListener('click', resume);
    $('btnStop').addEventListener('click', stop);
    $('btnInsert').addEventListener('click', insert);
    $('btnRestore').addEventListener('click', restoreInserted);
    $('btnClear').addEventListener('click', clearDraft);
    $('btnSettings').addEventListener('click', function () { openSettings(); });
    $('btnSaveSettings').addEventListener('click', function () {
      saveSettings();
      $('settingsMsg').textContent = S.settings.apiKey ? 'Saved.' : 'Saved (no key yet).';
      if (S.settings.apiKey && $('alertTitle').textContent.indexOf('API key') > -1 && !S.failed.length) clearAlert();
    });
    $('btnTestKey').addEventListener('click', testKey);
    $('draft').addEventListener('input', function () { S.userEdited = true; hideNotice(); persistDraft(); render(); });

    if (ssGet(SS_RELOADED)) {
      ssDel(SS_RELOADED);
      showAlert('info', 'Microphone allowed', 'Select Start recording to begin.');
    } else if (!S.settings.apiKey) {
      openSettings(true);
      showAlert('info', 'One-time setup', 'Paste your OpenAI API key in Settings and select Save.');
    }
    render();
  }

  var booted = false;
  function boot(info) {
    if (info && window.Office && info.host === Office.HostType.Outlook) S.inOutlook = true;
    if (booted) { render(); return; }   // Office may report ready after the fallback timer
    booted = true;
    init();
  }
  if (window.Office && Office.onReady) {
    Office.onReady(boot);
    setTimeout(function () { boot(null); }, 4000);   // opened outside Office: still usable for testing
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(null); });
  } else {
    boot(null);
  }

  // test hook
  window.__aiva = { polish: polish, state: S };
})();
