// The messenger page's script (views/messages.ejs), served as a cached file since 2026-09-21:
// 170 KB used to be inlined in every chat page. The page's own values come in window.__MSG__,
// written by a small inline script just before this one loads.
(function() {
  const M = window.__MSG__ || {};
  // The verified mark, as the profile draws it, after a verified person's name.
  const VERIFIED_HTML = '<span class="verified-check" title="Verified"><svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#1a1a2e"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const CONV_ID = M.CONV_ID;
  const COMMUNITY_LANG = M.COMMUNITY_LANG;
  const REACTION_URLS = M.REACTION_URLS;
  const RX = M.RX;
  const USER_ID = M.USER_ID;
  const IS_GROUP = M.IS_GROUP;
  const IS_ADMIN = M.IS_ADMIN;
  const LANG = M.LANG;
  const TIME_LOCALE = M.TIME_LOCALE;
  const SERVER_TZ = M.SERVER_TZ;
  let LOCAL_TZ = M.LOCAL_TZ;
  const TIMES_ARE_LOCAL = M.TIMES_ARE_LOCAL;
  const USERNAME = M.USERNAME;
  const ATTACH_RULES = M.ATTACH_RULES;
  const OTHER_NAME = M.OTHER_NAME;
  const SHOW_RECEIPTS = M.SHOW_RECEIPTS;
  const CAN_PIN = M.CAN_PIN;
  const CHAT_INFO = M.CHAT_INFO;
  let readCutoff = M.readCutoff;
  let hasMoreHistory = M.hasMoreHistory;
  const rankClassFor = M.rankClassFor;
  let loadingHistory = false;
  let bottomDayKey = null;   // the reader's day key of the newest rendered message
  let oldestMsgId = 0;       // smallest real message id currently rendered (for history paging)
  let lastMsgId = 0;
  let pollTimer = null;
  let editingMsgId = null;
  let replyingTo = null;
  let lastPollTime = new Date().toISOString();

  // Members panel toggle
  const toggleMembersBtn = document.getElementById('toggleMembers');
  const membersPanel = document.getElementById('membersPanel');
  if (toggleMembersBtn && membersPanel) {
    toggleMembersBtn.addEventListener('click', function() {
      membersPanel.classList.toggle('show');
    });
  }
  const showMoreBtn = document.getElementById('showMoreMembers');
  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', function() {
      document.querySelectorAll('[data-extra-member]').forEach(function(el) {
        el.style.display = '';
      });
      showMoreBtn.style.display = 'none';
    });
  }

  // Get last message ID for polling
  const chatEl = document.getElementById('chatMessages');
  const rowEls = chatEl ? chatEl.querySelectorAll('.msg-bubble-row[data-msg-id]') : [];
  regroupDaySeparators();
  if (rowEls.length > 0) {
    // The largest id, not the last row's: a message inserted after the fact (the English
    // halves of the split announcements) sorts by its original time but has a newer id, and
    // /poll?after= would otherwise hand it back on every reconnect.
    rowEls.forEach(function(el) { lastMsgId = Math.max(lastMsgId, parseInt(el.dataset.msgId) || 0); });
    bottomDayKey = clientDayKey(rowEls[rowEls.length - 1].dataset.created);
    oldestMsgId = parseInt(rowEls[0].dataset.msgId) || 0;
  }

  // Initial scroll: to a #msg-<id> permalink, else the "new messages" divider,
  // else the bottom. (MathJax pageReady re-applies this after typesetting.)
  if (chatEl) {
    var _hash = (location.hash.match(/^#msg-(\d+)$/) || [])[1];
    var _target = _hash ? chatEl.querySelector('.msg-bubble-row[data-msg-id="' + _hash + '"]') : null;
    var _divider = document.getElementById('newMessagesDivider');
    if (_target) { _target.scrollIntoView({ block: 'center' }); }
    else if (_hash) { setTimeout(function() { jumpToMessageDeep(_hash); }, 150); }
    else if (_divider) { _divider.scrollIntoView({ block: 'center' }); }
    else { chatEl.scrollTop = chatEl.scrollHeight; }
  }

  // Auto-resize textarea
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const editBar = document.getElementById('editBar');
  const editBarText = document.getElementById('editBarText');
  const editCancel = document.getElementById('editCancel');
  const replyBar = document.getElementById('replyBar');
  const replyBarName = document.getElementById('replyBarName');
  const replyBarText = document.getElementById('replyBarText');
  const replyCancel = document.getElementById('replyCancel');

  // Image attachment elements
  const attachBtn = document.getElementById('attachBtn');
  const fileInput = document.getElementById('imageFileInput');
  const sendDialog = document.getElementById('sendDialog');
  const sendDialogTitle = document.getElementById('sendDialogTitle');
  const sendPreviewImg = document.getElementById('sendPreviewImg');
  const sendPreviewVideo = document.getElementById('sendPreviewVideo');
  const sendPreviewFile = document.getElementById('sendPreviewFile');
  const sendPreviewName = document.getElementById('sendPreviewName');
  const sendPreviewSize = document.getElementById('sendPreviewSize');
  const sendAsFileRow = document.getElementById('sendAsFileRow');
  const sendAsFile = document.getElementById('sendAsFile');
  const sendCaption = document.getElementById('sendCaption');
  const mediaViewer = document.getElementById('mediaViewer');
  const sendPreviewGrid = document.getElementById('sendPreviewGrid');
  /* The attachments staged for the next send, in the order chosen (several at once since
     2026-09-21; up to ATTACH_MAX_AT_ONCE). Each: { file, name (a pasted image has none, so
     one is given), kind ('image' | 'video' | 'audio' | 'file'), isImage, url (an object URL
     for a picture or a video: the preview and the bubble drawn before the reply), w, h (a
     picture's natural size, once known) }. Every one becomes its own message. */
  const ATTACH_MAX_AT_ONCE = 10;
  let pendingQueue = [];
  let pendingAsFile = false;    // "send as a document": pictures and videos shown as file cards

  function updateSendEnabled() {
    sendBtn.disabled = !msgInput.value.trim() && !pendingQueue.length;
  }

  if (msgInput) {
    msgInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      updateSendEnabled();
      maybeSendTyping();
      if (!editingMsgId) saveDraft();
    });

    msgInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (msgInput.value.trim() || pendingQueue.length) {
          if (editingMsgId) {
            submitEdit();
          } else {
            sendMessage();
          }
        }
      }
      if (e.key === 'Escape') {
        if (editingMsgId) cancelEdit();
        else if (replyingTo) cancelReply();
      }
    });

    restoreDraft();
    msgInput.focus();
  }

  // Per-conversation compose drafts (localStorage).
  function draftKey() { return CONV_ID ? 'msgDraft:' + CONV_ID : null; }
  function saveDraft() {
    var k = draftKey(); if (!k) return;
    try { if (msgInput.value) localStorage.setItem(k, msgInput.value); else localStorage.removeItem(k); } catch (e) {}
  }
  function clearDraft() {
    var k = draftKey(); if (!k) return;
    try { localStorage.removeItem(k); } catch (e) {}
  }
  function restoreDraft() {
    var k = draftKey(); if (!k || !msgInput) return;
    var v;
    try { v = localStorage.getItem(k); } catch (e) { v = null; }
    if (v) {
      msgInput.value = v;
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
      updateSendEnabled();
    }
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', function() {
      if (msgInput.value.trim() || pendingQueue.length) {
        if (editingMsgId) {
          submitEdit();
        } else {
          sendMessage();
        }
      }
    });
  }

  // ── Community chat language hint ────────────────────────────────────
  // While a draft is clearly in the other community chat's language, show a pointer to
  // that chat. Advice only: nothing here touches sending, and a missing or failed
  // js/chat-language.js just means no hint.
  const langHintBar = document.getElementById('langHintBar');
  if (langHintBar && msgInput && COMMUNITY_LANG) {
    const langHintClose = document.getElementById('langHintClose');
    const langHintLink = document.getElementById('langHintLink');
    const hintDismissKey = 'msgLangHintDismissed:' + CONV_ID;
    let hintTimer = null;
    const hintDismissed = function() {
      try { return localStorage.getItem(hintDismissKey) === '1'; } catch (e) { return false; }
    };
    const updateLangHint = function() {
      const api = window.ChatLanguage;
      langHintBar.hidden = !(api && !editingMsgId && !hintDismissed() &&
        api.languageHint(msgInput.value, COMMUNITY_LANG));
    };
    const scheduleLangHint = function() {
      clearTimeout(hintTimer);
      hintTimer = setTimeout(updateLangHint, 400);
    };
    msgInput.addEventListener('input', scheduleLangHint);
    msgInput.addEventListener('keyup', scheduleLangHint); // Enter sends and clears without an input event
    if (sendBtn) sendBtn.addEventListener('click', scheduleLangHint);
    if (langHintClose) {
      langHintClose.addEventListener('click', function() {
        try { localStorage.setItem(hintDismissKey, '1'); } catch (e) {}
        langHintBar.hidden = true;
      });
    }
    if (langHintLink) {
      // Take the draft along, so the message typed in the wrong chat is waiting in the right one.
      langHintLink.addEventListener('click', function() {
        if (!msgInput.value.trim()) return;
        try {
          const target = 'msgDraft:' + langHintLink.dataset.convId;
          if (!localStorage.getItem(target)) {
            localStorage.setItem(target, msgInput.value);
            clearDraft();
          }
        } catch (e) {}
      });
    }
    updateLangHint(); // a restored draft may already be in the other language
  }

  if (editCancel) {
    editCancel.addEventListener('click', cancelEdit);
  }

  if (replyCancel) {
    replyCancel.addEventListener('click', cancelReply);
  }

  // The attach button opens a small menu: a photo or video, a document, a poll (Telegram's).
  const attachMenu = document.getElementById('attachMenu');
  const ATTACH_ACCEPT_ALL = fileInput ? fileInput.getAttribute('accept') : '';
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!attachMenu) { fileInput.click(); return; }
      attachMenu.hidden = !attachMenu.hidden;
    });
    if (attachMenu) {
      attachMenu.addEventListener('click', function(e) {
        const item = e.target.closest('[data-attach]');
        if (!item) return;
        attachMenu.hidden = true;
        if (item.dataset.attach === 'poll') { openPollModal(); return; }
        fileInput.setAttribute('accept', item.dataset.attach === 'media' ? 'image/*,video/*' : ATTACH_ACCEPT_ALL);
        fileInput.click();
      });
      document.addEventListener('click', function(e) { if (!attachMenu.hidden && !e.target.closest('#attachMenu')) attachMenu.hidden = true; });
      document.addEventListener('keydown', function(e) { if (e.key === 'Escape') attachMenu.hidden = true; });
    }

    fileInput.addEventListener('change', function() {
      if (!this.files || !this.files.length) return;
      if (!stageAttachments(this.files)) this.value = '';
    });
  }

  function attachmentExtension(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  // 'image' | 'video' | 'file' | null, by the same lists the server applies.
  function attachmentKind(name) {
    const ext = attachmentExtension(name);
    if (ATTACH_RULES.image.indexOf(ext) !== -1) return 'image';
    if (ATTACH_RULES.video.indexOf(ext) !== -1) return 'video';
    if (ATTACH_RULES.audio.indexOf(ext) !== -1) return 'audio';
    if (ATTACH_RULES.other.indexOf(ext) !== -1) return 'file';
    return null;
  }
  function attachmentLimit(name) {
    const kind = attachmentKind(name);
    return (kind === 'video' || kind === 'audio') ? ATTACH_RULES.videoMaxBytes : ATTACH_RULES.maxBytes;
  }
  function attachmentLimitText(name) {
    const mb = Math.round(attachmentLimit(name) / 1048576);
    const kind = attachmentKind(name);
    const what = LANG === 'ru'
      ? (kind === 'video' ? 'Видео до ' : kind === 'audio' ? 'Аудио до ' : 'Файл до ')
      : (kind === 'video' ? 'A video can be up to ' : kind === 'audio' ? 'An audio file can be up to ' : 'A file can be up to ');
    return what + mb + (LANG === 'ru' ? ' МБ' : ' MB');
  }

  /* Stage attachments for the next send: each one checked by the same lists and limits the
     server applies, the ones that fail named in one alert, the rest shown in the send dialog.
     Returns false when nothing was accepted. A drop or a paste while the dialog is open adds
     to what is there. */
  function ruPlural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function releaseQueue() {
    pendingQueue.forEach(function(it) { if (it.url) { try { URL.revokeObjectURL(it.url); } catch (e) {} } });
    pendingQueue = [];
    pendingAsFile = false;
  }
  function stageAttachments(files) {
    const list = Array.prototype.slice.call(files || []).filter(Boolean);
    if (!list.length) return false;
    const rejected = [];
    let accepted = [];
    list.forEach(function(file) {
      // A pasted image has no name; it arrives as image/* and is sent as png.
      const name = file.name || (/^image\//.test(file.type) ? 'pasted.png' : '');
      const kind = attachmentKind(name);
      if (!kind) {
        rejected.push((name || '?') + ' — ' + (LANG === 'ru' ? 'такой тип файла нельзя отправить' : 'this file type cannot be sent'));
        return;
      }
      if (file.size > attachmentLimit(name)) {
        rejected.push(name + ' — ' + attachmentLimitText(name));
        return;
      }
      accepted.push({ file: file, name: name, kind: kind, isImage: kind === 'image', url: null, w: 0, h: 0 });
    });
    const room = ATTACH_MAX_AT_ONCE - pendingQueue.length;
    if (accepted.length > room) {
      rejected.push(LANG === 'ru'
        ? 'Не больше ' + ATTACH_MAX_AT_ONCE + ' файлов за раз'
        : 'Up to ' + ATTACH_MAX_AT_ONCE + ' files at a time');
      accepted = accepted.slice(0, Math.max(0, room));
    }
    if (rejected.length) alert(rejected.join('\n'));
    if (!accepted.length) return false;
    accepted.forEach(function(it) {
      if ((it.isImage || it.kind === 'video') && window.URL && URL.createObjectURL) {
        it.url = URL.createObjectURL(it.file);
      }
      if (it.isImage && it.url) {
        const probe = new Image();
        probe.onload = function() { it.w = probe.naturalWidth || 0; it.h = probe.naturalHeight || 0; };
        probe.src = it.url;
      }
    });
    pendingQueue = pendingQueue.concat(accepted);
    pendingAsFile = false;
    openSendDialog();
    updateSendEnabled();
    return true;
  }

  /* "Send a file", as Telegram asks before sending: what was chosen, a caption, and for a picture
     or a video whether to send it as a file instead. One attachment shows large: a video plays from
     the file in memory — nothing is uploaded until Send; one this browser cannot decode (OpenCV's
     mp4v, an iPhone's HEVC in Firefox) shows as a file and says it will be converted after sending,
     which is what the server then does. Several show as tiles, each with a cross to leave it out,
     and a picture or a video among them opens in the viewer on click. The composer's text becomes
     the caption, which goes under the last. */
  let previewVideoUrl = null;
  function clearPreviewVideo() {
    if (!sendPreviewVideo) return;
    sendPreviewVideo.onerror = null;
    try { sendPreviewVideo.pause(); } catch (e) {}
    sendPreviewVideo.removeAttribute('src');
    sendPreviewVideo.load();
    sendPreviewVideo.hidden = true;
    previewVideoUrl = null; // the object URL belongs to the queue item and is released with it
  }
  function showSendFile(name, size, note) {
    sendPreviewName.textContent = name;
    sendPreviewSize.textContent = formatBytes(size) + (note ? '  ·  ' + note : '');
    sendPreviewFile.hidden = false;
  }
  function sendDialogTitleFor(items) {
    const n = items.length;
    const single = {
      image: LANG === 'ru' ? 'Отправить фото' : 'Send an image',
      video: LANG === 'ru' ? 'Отправить видео' : 'Send a video',
      audio: LANG === 'ru' ? 'Отправить аудио' : 'Send audio',
      file: LANG === 'ru' ? 'Отправить файл' : 'Send a file',
    };
    if (n === 1) return single[items[0].kind] || single.file;
    const allImages = items.every(function(it) { return it.isImage; });
    if (LANG === 'ru') {
      return 'Отправить ' + n + ' ' + (allImages ? 'фото' : ruPlural(n, 'файл', 'файла', 'файлов'));
    }
    return 'Send ' + n + ' ' + (allImages ? 'photos' : 'files');
  }
  function fileGlyph() {
    return '<span class="msg-bubble-file-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>';
  }
  function renderSendGrid() {
    sendPreviewGrid.innerHTML = '';
    pendingQueue.forEach(function(it, index) {
      const tile = document.createElement('div');
      tile.className = 'msg-send-tile';
      if (it.isImage && it.url) {
        tile.innerHTML = '<img src="' + escAttr(it.url) + '" alt="" />';
      } else if (it.kind === 'video' && it.url) {
        tile.innerHTML = '<video src="' + escAttr(it.url) + '" muted playsinline preload="metadata"></video>';
      }
      if ((it.isImage || it.kind === 'video') && it.url) {
        tile.classList.add('is-media');
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'msg-send-tile-open';
        open.setAttribute('aria-label', LANG === 'ru' ? 'Посмотреть' : 'View');
        open.addEventListener('click', function() { openPendingInViewer(it); });
        tile.appendChild(open);
      } else {
        tile.innerHTML = fileGlyph() + '<span class="msg-send-tile-name"></span>';
        tile.querySelector('.msg-send-tile-name').textContent = it.name;
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'msg-send-tile-remove';
      remove.setAttribute('aria-label', LANG === 'ru' ? 'Убрать' : 'Remove');
      remove.textContent = '×';
      remove.addEventListener('click', function() {
        const gone = pendingQueue.splice(index, 1)[0];
        if (gone && gone.url) { try { URL.revokeObjectURL(gone.url); } catch (e) {} }
        if (!pendingQueue.length) return closeSendDialog(true);
        openSendDialog();
      });
      tile.appendChild(remove);
      sendPreviewGrid.appendChild(tile);
    });
    sendPreviewGrid.classList.toggle('is-few', pendingQueue.length <= 4);
    sendPreviewGrid.hidden = false;
  }
  /* A click on a staged picture or video shows it full size in the media viewer, with the
     batch's other media beside it (arrows, ← →); Esc or the backdrop comes back to the dialog. */
  function openPendingInViewer(it) {
    const items = pendingQueue.filter(function(q) { return (q.isImage || q.kind === 'video') && q.url; }).map(function(q) {
      return { kind: q.isImage ? 'image' : 'video', src: q.url, name: q.name, poster: '', caption: '', sender: '', created: '', wrap: null };
    });
    const i = items.findIndex(function(v) { return v.src === it.url; });
    if (i >= 0) openViewerItems(items, i);
  }
  function openSendDialog() {
    if (!sendDialog) return;
    clearPreviewVideo();
    sendPreviewImg.hidden = true; sendPreviewImg.removeAttribute('src');
    sendPreviewFile.hidden = true;
    sendPreviewGrid.hidden = true;
    const items = pendingQueue;
    if (!items.length) return closeSendDialog(true);
    sendDialogTitle.textContent = sendDialogTitleFor(items);
    if (items.length > 1) {
      renderSendGrid();
    } else {
      const it = items[0];
      if (it.isImage && it.url) {
        sendPreviewImg.src = it.url;
        sendPreviewImg.hidden = false;
        sendPreviewImg.onclick = function() { openPendingInViewer(it); };
      } else if (it.kind === 'video' && it.url) {
        previewVideoUrl = it.url;
        sendPreviewVideo.onerror = function() {
          clearPreviewVideo();
          showSendFile(it.name, it.file.size, LANG === 'ru' ? 'будет сконвертировано после отправки' : 'converted after sending');
        };
        sendPreviewVideo.src = previewVideoUrl;
        sendPreviewVideo.hidden = false;
      } else {
        showSendFile(it.name, it.file.size, '');
      }
    }
    sendAsFileRow.hidden = !items.some(function(it) { return it.isImage || it.kind === 'video'; });
    if (!sendDialog.hidden) return; // adding to an open dialog keeps its caption and choice
    sendAsFile.checked = false;
    sendCaption.value = msgInput ? msgInput.value : '';
    sendDialog.hidden = false;
    setTimeout(function() { sendCaption.focus(); }, 0);
  }
  function closeSendDialog(cancelled) {
    if (!sendDialog) return;
    sendDialog.hidden = true;
    clearPreviewVideo();
    if (cancelled) {
      releaseQueue();
      if (fileInput) fileInput.value = '';
      updateSendEnabled();
      if (msgInput) msgInput.focus();
    }
  }
  function submitSendDialog() {
    if (!pendingQueue.length) return closeSendDialog(true);
    pendingAsFile = !sendAsFileRow.hidden && sendAsFile.checked;
    if (msgInput) msgInput.value = sendCaption.value;
    closeSendDialog(false);
    sendMessage();
  }
  if (sendDialog) {
    document.getElementById('sendDialogSend').addEventListener('click', submitSendDialog);
    document.getElementById('sendDialogCancel').addEventListener('click', function() { closeSendDialog(true); });
    document.getElementById('sendDialogClose').addEventListener('click', function() { closeSendDialog(true); });
    document.getElementById('sendDialogBackdrop').addEventListener('click', function() { closeSendDialog(true); });
    sendCaption.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); submitSendDialog(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSendDialog(true); }
    });
    sendCaption.addEventListener('input', function() {
      sendCaption.style.height = 'auto';
      sendCaption.style.height = Math.min(sendCaption.scrollHeight, 160) + 'px';
    });
  }

  /* Files arrive by the picker, by a drop anywhere on the chat column, and by paste (a screenshot
     from the clipboard, or a file copied in a file manager where the browser passes it on). All of
     them are staged; each becomes its own message. */
  function hasFiles(e) {
    const t = e.dataTransfer;
    return !!(t && t.types && Array.prototype.indexOf.call(t.types, 'Files') !== -1);
  }
  const dropZone = document.querySelector('.msg-chat');
  let dragDepth = 0;
  function endDrag() { dragDepth = 0; if (dropZone) dropZone.classList.remove('is-dropping'); }
  document.addEventListener('dragenter', function(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!CONV_ID || !dropZone) return;
    dragDepth++;
    dropZone.classList.add('is-dropping');
  });
  document.addEventListener('dragover', function(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = CONV_ID ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', function(e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || e.relatedTarget === null) endDrag();
  });
  document.addEventListener('drop', function(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    endDrag();
    if (!CONV_ID) return;
    const files = e.dataTransfer.files;
    if (files && files.length && stageAttachments(files) && msgInput) msgInput.focus();
  });
  document.addEventListener('paste', function(e) {
    if (!CONV_ID) return;
    const t = e.target;
    if (t && t !== msgInput && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const dt = e.clipboardData;
    if (!dt) return;
    let files = (dt.files && dt.files.length) ? Array.prototype.slice.call(dt.files) : [];
    if (!files.length && dt.items) {
      for (let i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind === 'file') { const f = dt.items[i].getAsFile(); if (f) files.push(f); }
      }
    }
    if (!files.length) return;   // plain text: the textarea takes it as usual
    if (stageAttachments(files)) { e.preventDefault(); if (msgInput) msgInput.focus(); }
  });


  // Jump to the quoted message when a reply preview is clicked.
  function jumpToMessage(targetId) {
    if (!targetId) return;
    const target = chatEl && chatEl.querySelector('.msg-bubble-row[data-msg-id="' + targetId + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const bubble = target.querySelector('.msg-bubble');
    if (bubble) {
      bubble.classList.remove('flash');
      void bubble.offsetWidth; // restart the animation
      bubble.classList.add('flash');
      setTimeout(function() { bubble.classList.remove('flash'); }, 1300);
    }
  }

  /* ── The media viewer ─────────────────────────────────────────────────────────────────
     A click on a picture or a video opens it here, the way Telegram Desktop does: the chat's
     media in order, arrows and ← → keys between them, Esc or the backdrop to close, a swipe on a
     phone. A video plays in the viewer with the browser's controls. The list is read from the
     rows on screen each time the viewer opens, so what history has loaded is what it shows. */
  const viewer = {
    items: [], index: -1,
    stage: document.getElementById('viewerStage'), caption: document.getElementById('viewerCaption'),
    prev: document.getElementById('viewerPrev'), next: document.getElementById('viewerNext'),
    count: document.getElementById('viewerCount'), meta: document.getElementById('viewerMeta'),
    download: document.getElementById('viewerDownload'), strip: document.getElementById('viewerStrip'),
  };
  function viewerItemsFromChat() {
    const items = [];
    if (!chatEl) return items;
    chatEl.querySelectorAll('.msg-bubble-row .msg-media').forEach(function(wrap) {
      const row = wrap.closest('.msg-bubble-row');
      const img = wrap.querySelector('.msg-bubble-image');
      const video = wrap.querySelector('.msg-bubble-video');
      if (!row || (!img && !video)) return;
      const captionEl = row.querySelector('.msg-caption');
      let caption = '';
      if (captionEl) {
        const c = captionEl.cloneNode(true);
        c.querySelectorAll('.msg-bubble-time, .msg-bubble-edited').forEach(function(el) { el.remove(); });
        caption = c.innerHTML;
      }
      items.push({
        kind: img ? 'image' : 'video',
        src: img ? (img.dataset.full || img.src) : video.getAttribute('src'),
        name: img ? (img.dataset.full || img.src).split('/').pop() : (video.dataset.name || 'video.mp4'),
        poster: wrap.style.backgroundImage || '',
        caption: caption,
        sender: row.dataset.senderName || '',
        created: row.dataset.created || '',
        wrap: wrap,
      });
    });
    return items;
  }
  function viewerStopVideo() {
    const v = viewer.stage.querySelector('video');
    if (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); v.load(); }
    viewer.stage.innerHTML = '';
  }
  function viewerShow(i) {
    const it = viewer.items[i];
    if (!it) return;
    viewer.index = i;
    viewerStopVideo();
    if (it.kind === 'image') {
      const img = document.createElement('img');
      img.src = it.src; img.alt = '';
      viewer.stage.appendChild(img);
    } else {
      const v = document.createElement('video');
      v.src = it.src; v.controls = true; v.autoplay = true; v.playsInline = true; v.preload = 'auto';
      viewer.stage.appendChild(v);
      const p = v.play(); if (p && p.catch) p.catch(function() {});
    }
    viewer.caption.innerHTML = it.caption;
    const n = viewer.items.length;
    const what = it.kind === 'image' ? (LANG === 'ru' ? 'Фото' : 'Photo') : it.name;
    viewer.count.innerHTML = '<strong>' + esc(what) + '</strong> ' + (i + 1) + ' ' + (LANG === 'ru' ? 'из' : 'of') + ' ' + n;
    const when = it.created ? new Date(it.created) : null;
    viewer.meta.textContent = [it.sender, when && !isNaN(when.getTime())
      ? when.toLocaleDateString(TIME_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + (LANG === 'ru' ? 'в' : 'at') + ' ' + fmtTime(it.created)
      : ''].filter(Boolean).join(' • ');
    viewer.download.href = it.src; viewer.download.setAttribute('download', it.name);
    viewer.prev.disabled = i === 0; viewer.next.disabled = i === n - 1;
    viewer.strip.querySelectorAll('.msg-viewer-thumb').forEach(function(t, k) { t.classList.toggle('is-current', k === i); });
    const cur = viewer.strip.querySelector('.msg-viewer-thumb.is-current');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
    // the neighbours, so the next step is instant
    [i - 1, i + 1].forEach(function(k) { const o = viewer.items[k]; if (o && o.kind === 'image') { const pre = new Image(); pre.src = o.src; } });
  }
  function openViewer(wrap) {
    const items = viewerItemsFromChat();
    const i = items.findIndex(function(it) { return it.wrap === wrap; });
    if (i >= 0) openViewerItems(items, i);
  }
  function openViewerItems(items, i) {
    if (!mediaViewer || !items.length) return;
    viewer.items = items;
    const playSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
    viewer.strip.innerHTML = viewer.items.map(function(it, k) {
      const inner = it.kind === 'image' ? '<img src="' + esc(it.src) + '" alt="" loading="lazy" />' : '<span class="msg-viewer-thumb-play">' + playSvg + '</span>';
      const style = it.kind === 'video' && it.poster ? ' style="background-image:' + it.poster.replace(/"/g, '&quot;') + '"' : '';
      return '<button type="button" class="msg-viewer-thumb" data-index="' + k + '"' + style + '>' + inner + '</button>';
    }).join('');
    mediaViewer.hidden = false;
    document.body.classList.add('msg-viewer-open');
    viewerShow(i);
  }
  function closeViewer() {
    if (!mediaViewer || mediaViewer.hidden) return;
    viewerStopVideo();
    mediaViewer.hidden = true;
    document.body.classList.remove('msg-viewer-open');
    viewer.items = []; viewer.index = -1;
  }
  if (mediaViewer) {
    viewer.prev.addEventListener('click', function() { if (viewer.index > 0) viewerShow(viewer.index - 1); });
    viewer.next.addEventListener('click', function() { if (viewer.index < viewer.items.length - 1) viewerShow(viewer.index + 1); });
    document.getElementById('viewerClose').addEventListener('click', closeViewer);
    viewer.strip.addEventListener('click', function(e) {
      const t = e.target.closest('.msg-viewer-thumb');
      if (t) viewerShow(parseInt(t.dataset.index));
    });
    // The backdrop closes; the media, the caption and the controls do not.
    mediaViewer.addEventListener('click', function(e) {
      if (e.target === mediaViewer || e.target === viewer.stage) closeViewer();
    });
    document.addEventListener('keydown', function(e) {
      if (mediaViewer.hidden) return;
      e.stopImmediatePropagation();          // the panel under it must not act on the same key
      if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
      else if (e.key === 'ArrowLeft' && viewer.index > 0) { e.preventDefault(); viewerShow(viewer.index - 1); }
      else if (e.key === 'ArrowRight' && viewer.index < viewer.items.length - 1) { e.preventDefault(); viewerShow(viewer.index + 1); }
    });
    let touchX = null;
    mediaViewer.addEventListener('touchstart', function(e) { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    mediaViewer.addEventListener('touchend', function(e) {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX; touchX = null;
      if (dx > 60 && viewer.index > 0) viewerShow(viewer.index - 1);
      else if (dx < -60 && viewer.index < viewer.items.length - 1) viewerShow(viewer.index + 1);
    }, { passive: true });
  }

  /* ── The chat's info panel ─────────────────────────────────────────────────────────────
     Telegram's: the avatar and name, who is in it, what to do with it (notifications, search,
     the profile, leaving), then what it holds — photos, videos, files, audio, links — each a
     list of its own inside the panel, drawn from /messages/:id/info and /messages/:id/media. */
  const chatInfo = document.getElementById('chatInfo');
  const chatInfoBody = document.getElementById('chatInfoBody');
  const chatInfoTitle = document.getElementById('chatInfoTitle');
  const chatInfoBack = document.getElementById('chatInfoBack');
  let chatInfoData = null;
  const INFO_KINDS = {
    photos: { ru: ['фото', 'фото', 'фото'], en: ['photo', 'photos', 'photos'], icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' },
    videos: { ru: ['видео', 'видео', 'видео'], en: ['video', 'videos', 'videos'], icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>' },
    files: { ru: ['файл', 'файла', 'файлов'], en: ['file', 'files', 'files'], icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' },
    audio: { ru: ['аудиофайл', 'аудиофайла', 'аудиофайлов'], en: ['audio file', 'audio files', 'audio files'], icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' },
    links: { ru: ['ссылка', 'ссылки', 'ссылок'], en: ['shared link', 'shared links', 'shared links'], icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
  };
  function plural(n, forms) {
    if (LANG !== 'ru') return n === 1 ? forms[0] : forms[1];
    const a = n % 10, b = n % 100;
    return (a === 1 && b !== 11) ? forms[0] : (a >= 2 && a <= 4 && (b < 10 || b >= 20)) ? forms[1] : forms[2];
  }
  function infoDate(iso, withTime) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(TIME_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) + (withTime ? ', ' + fmtTime(iso) : '');
  }
  function infoMonth(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(TIME_LOCALE, { month: 'long', year: 'numeric' });
  }
  function actionHTML(id, icon, label, extraClass, href) {
    const inner = icon + '<span>' + esc(label) + '</span>';
    if (href) return '<a class="msg-info-action' + (extraClass || '') + '" href="' + escAttr(href) + '">' + inner + '</a>';
    return '<button type="button" class="msg-info-action' + (extraClass || '') + '" data-action="' + id + '">' + inner + '</button>';
  }
  function renderInfoMain() {
    const c = CHAT_INFO, d = chatInfoData || { counts: {}, members: [] };
    const ru = LANG === 'ru';
    chatInfoTitle.textContent = '';
    chatInfoBack.hidden = true;
    let sub = '';
    if (c.isSaved) sub = ru ? 'Ваши заметки и пересланное' : 'Your notes and forwards';
    else if (c.isGroup) sub = c.memberCount + ' ' + plural(c.memberCount, ru ? ['участник', 'участника', 'участников'] : ['member', 'members', 'members']);
    /* A person: the username big in its rank's colour, the full name small under it (2026-09-21). */
    else if (c.other) sub = (c.otherFull && c.otherFull !== c.other ? c.otherFull : '') + (c.isOnline ? (c.otherFull && c.otherFull !== c.other ? ' · ' : '') + (ru ? 'в сети' : 'online') : '');
    const avatar = c.avatarSvg ? c.avatarSvg
      : c.isSaved ? '<svg class="msg-info-avatar-saved" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
      : '<img src="' + escAttr(c.picture || '/img/profile_images/Default_placeholder.svg') + '" alt="" />';
    const heroName = c.other ? c.other : c.name;
    const heroClass = c.other && c.otherRankKey ? ' ss-rank-c-' + c.otherRankKey + ' ss-rank-' + c.otherRankKey : '';
    /* A person's name (and picture) open their profile. */
    const heroLink = c.other ? '/user/' + encodeURIComponent(c.other) : null;
    const wrap = function(inner) { return heroLink ? '<a class="msg-info-hero-link" href="' + escAttr(heroLink) + '" data-no-rank>' + inner + '</a>' : inner; };
    let html = '<div class="msg-info-hero">' + wrap('<div class="msg-info-avatar">' + avatar + '</div>') + wrap('<div class="msg-info-name' + heroClass + '">' + esc(heroName) + '</div>') + (sub ? '<div class="msg-info-sub">' + esc(sub) + '</div>' : '') + '</div>';
    const bell = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
    const bellOff = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    const search = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    const person = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    const leave = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
    const gear = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    const actions = [];
    if (!c.isSaved) actions.push(actionHTML('mute', c.muted ? bellOff : bell, c.muted ? (ru ? 'Включить звук' : 'Unmute') : (ru ? 'Без звука' : 'Mute')));
    actions.push(actionHTML('search', search, ru ? 'Поиск' : 'Search'));
    if (c.other) actions.push(actionHTML('profile', person, ru ? 'Профиль' : 'Profile', '', '/user/' + encodeURIComponent(c.other)));
    if (c.isGroup && c.isAdmin) actions.push(actionHTML('manage', gear, ru ? 'Управление' : 'Manage'));
    if (c.isGroup && !c.community && document.getElementById('groupLeaveBtn')) actions.push(actionHTML('leave', leave, ru ? 'Выйти' : 'Leave', ' danger'));
    /* A one-to-one chat: block the person (they can no longer write to you) and delete the chat
       (it leaves your list and opens empty; nothing is deleted on the server, the other person
       keeps everything). Groups have neither. */
    const blockIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
    const trash = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    if (!c.isGroup && !c.isSaved && c.otherId) {
      actions.push(actionHTML('block', blockIcon, c.blockedByMe ? (ru ? 'Разблокировать' : 'Unblock') : (ru ? 'Заблокировать' : 'Block'), c.blockedByMe ? '' : ' danger'));
      actions.push(actionHTML('delete-chat', trash, ru ? 'Удалить чат' : 'Delete chat', ' danger'));
    }
    html += '<div class="msg-info-actions">' + actions.join('') + '</div>';
    // what the chat holds
    let rows = '';
    Object.keys(INFO_KINDS).forEach(function(k) {
      const n = Number(d.counts[k]) || 0;
      if (!n) return;
      rows += '<button type="button" class="msg-info-row" data-kind="' + k + '">' + INFO_KINDS[k].icon + '<span>' + n + ' ' + plural(n, INFO_KINDS[k][ru ? 'ru' : 'en']) + '</span></button>';
    });
    html += '<div class="msg-info-section">' + (rows || '<div class="msg-info-empty">' + (chatInfoData ? (ru ? 'Здесь ещё не делились ни фото, ни файлами, ни ссылками' : 'No photos, files or links shared here yet') : '…') + '</div>') + '</div>';
    // who is in it: the first dozen, then the rest of the loaded page, then more pages
    if (c.isGroup && d.members && d.members.length) {
      const total = d.memberCount || c.memberCount || d.members.length;
      html += '<div class="msg-info-section" id="chatInfoMembers"><div class="msg-info-month">' + total + ' ' + plural(total, ru ? ['участник', 'участника', 'участников'] : ['member', 'members', 'members']) + '</div>' +
        d.members.map(function(m, i) { return memberRowHTML(m, i >= 12); }).join('') +
        (d.members.length > 12 || total > d.members.length ? '<button type="button" class="msg-info-more" data-action="all-members">' + (ru ? 'Показать всех' : 'Show all') + '</button>' : '') + '</div>';
    }
    chatInfoBody.innerHTML = html;
    chatInfoBody.scrollTop = 0;
  }
  function memberRowHTML(m, hidden) {
    const ru = LANG === 'ru';
    return '<a class="msg-info-member" href="/user/' + encodeURIComponent(m.username) + '"' + (hidden ? ' hidden data-extra' : '') + '><img src="' + escAttr(m.profile_picture || '/img/profile_images/Default_placeholder.svg') + '" alt="" loading="lazy" /><span><span class="msg-info-member-name">' + esc(m.full_name || m.username) + (m.role === 'admin' ? ' <span class="msg-admin-badge">' + (ru ? 'модератор' : 'mod') + '</span>' : '') + '</span><span class="msg-info-member-sub">@' + esc(m.username) + (m.isOnline ? ' · ' + (ru ? 'в сети' : 'online') : '') + '</span></span></a>';
  }
  // The next page of members, appended before the button that asked for it.
  function loadMoreMembers(btn) {
    const section = document.getElementById('chatInfoMembers');
    if (!section) return;
    const offset = section.querySelectorAll('.msg-info-member').length;
    btn.disabled = true;
    fetch('/messages/' + CONV_ID + '/members?offset=' + offset, { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d || !d.members) return;
        if (chatInfoData) chatInfoData.members = chatInfoData.members.concat(d.members);
        btn.insertAdjacentHTML('beforebegin', d.members.map(function(m) { return memberRowHTML(m, false); }).join(''));
        if (d.more) btn.disabled = false; else btn.remove();
      })
      .catch(function() { btn.disabled = false; });
  }
  function renderInfoList(kind, items, more) {
    const ru = LANG === 'ru';
    chatInfoBack.hidden = false;
    chatInfoTitle.textContent = { photos: ru ? 'Фото' : 'Photos', videos: ru ? 'Видео' : 'Videos', files: ru ? 'Файлы' : 'Files', audio: ru ? 'Аудио' : 'Audio', links: ru ? 'Ссылки' : 'Shared links' }[kind];
    let html = '';
    if (!items.length) html = '<div class="msg-info-empty">' + (ru ? 'Пусто' : 'Nothing here') + '</div>';
    else if (kind === 'photos' || kind === 'videos') {
      let month = null, open = false;
      items.forEach(function(it, i) {
        const m = infoMonth(it.created_at);
        if (m !== month) { if (open) html += '</div>'; html += '<div class="msg-info-month">' + esc(m) + '</div><div class="msg-info-grid">'; month = m; open = true; }
        const bg = it.image_placeholder ? ' data-bg="' + escAttr(it.image_placeholder) + '"' : '';
        html += '<button type="button" class="msg-info-tile" data-index="' + i + '"' + bg + '>' +
          (kind === 'photos' ? '<img src="' + escAttr(it.image_url) + '" alt="" loading="lazy" />' : '<span class="msg-video-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg></span>') + '</button>';
      });
      if (open) html += '</div>';
    } else if (kind === 'links') {
      let day = null;
      items.forEach(function(it) {
        const d = infoDate(it.created_at);
        if (d !== day) { html += '<div class="msg-info-month">' + esc(d) + '</div>'; day = d; }
        const text = (it.content || '').length > 300 ? it.content.slice(0, 300) + '…' : (it.content || '');
        html += '<div class="msg-info-link" data-msg="' + it.id + '"><span class="msg-info-link-who">' + esc(it.sender_username || '') + '</span><span class="msg-info-link-text">' + linkify(text) + '</span></div>';
      });
    } else {
      let day = null;
      items.forEach(function(it) {
        const d = infoDate(it.created_at);
        if (d !== day) { html += '<div class="msg-info-month">' + esc(d) + '</div>'; day = d; }
        html += '<div class="msg-info-file">' + (kind === 'audio' ? renderAudioHTML(it) : renderFileCardHTML(it)) + '</div>';
      });
    }
    if (more) html += '<button type="button" class="msg-info-more" data-action="more" data-kind="' + kind + '" data-before="' + items[items.length - 1].id + '">' + (ru ? 'Показать ещё' : 'Show more') + '</button>';
    chatInfoBody.innerHTML = html;
    chatInfoBody.querySelectorAll('.msg-info-tile[data-bg]').forEach(function(t) { t.style.backgroundImage = 'url(' + t.dataset.bg + ')'; });
    chatInfoBody.scrollTop = 0;
    chatInfoBody.dataset.kind = kind;
    chatInfoBody.__items = items;
  }
  function loadInfoList(kind, before) {
    fetch('/messages/' + CONV_ID + '/media?kind=' + kind + (before ? '&before=' + before : ''), { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d || !d.items) return;
        if (before) {
          const prev = chatInfoBody.__items || [];
          renderInfoList(kind, prev.concat(d.items), d.more);
        } else renderInfoList(kind, d.items, d.more);
      })
      .catch(function() {});
  }
  function openChatInfo() {
    if (!chatInfo || !CHAT_INFO || !CONV_ID) return;
    chatInfo.hidden = false;
    renderInfoMain();
    fetch('/messages/' + CONV_ID + '/info', { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d && d.counts) { chatInfoData = d; if (!chatInfoBack.hidden) return; renderInfoMain(); } })
      .catch(function() {});
  }
  function closeChatInfo() { if (chatInfo) chatInfo.hidden = true; }
  if (chatInfo) {
    const opener = document.getElementById('chatInfoOpen');
    if (opener) opener.addEventListener('click', openChatInfo);
    const headerAvatar = document.querySelector('.msg-chat-header .msg-conv-avatar-group, .msg-chat-header .msg-saved-avatar');
    if (headerAvatar) { headerAvatar.style.cursor = 'pointer'; headerAvatar.addEventListener('click', openChatInfo); }
    /* A person's picture and full name in the header open the panel too (the owner, 2026-09-21);
       the panel's own name and picture lead to the profile. */
    const headerPersonAvatar = document.querySelector('.msg-chat-header .msg-chat-header-avatar-link');
    if (headerPersonAvatar) headerPersonAvatar.addEventListener('click', function(e) { e.preventDefault(); openChatInfo(); });
    const headerFullName = document.querySelector('.msg-chat-header .msg-chat-header-fullname');
    if (headerFullName) { headerFullName.style.cursor = 'pointer'; headerFullName.addEventListener('click', openChatInfo); }
    document.getElementById('chatInfoClose').addEventListener('click', closeChatInfo);
    document.getElementById('chatInfoBackdrop').addEventListener('click', closeChatInfo);
    chatInfoBack.addEventListener('click', renderInfoMain);
    document.addEventListener('keydown', function(e) {
      if (chatInfo.hidden || e.key !== 'Escape' || (mediaViewer && !mediaViewer.hidden)) return;
      if (!chatInfoBack.hidden) renderInfoMain(); else closeChatInfo();
    });
    chatInfoBody.addEventListener('click', function(e) {
      const row = e.target.closest('.msg-info-row');
      if (row) { loadInfoList(row.dataset.kind); return; }
      const act = e.target.closest('[data-action]');
      if (act) {
        const a = act.dataset.action;
        if (a === 'mute') { const b = document.getElementById('muteToggle'); if (b) b.click(); CHAT_INFO.muted = !CHAT_INFO.muted; renderInfoMain(); }
        else if (a === 'search') { closeChatInfo(); const b = document.getElementById('searchToggle'); if (b) b.click(); }
        else if (a === 'manage') { closeChatInfo(); const p = document.getElementById('membersPanel'); if (p) p.classList.add('show'); }
        else if (a === 'leave') { closeChatInfo(); const b = document.getElementById('groupLeaveBtn'); if (b) b.click(); }
        else if (a === 'block') {
          const ru = LANG === 'ru';
          if (!CHAT_INFO.blockedByMe && !confirm(ru ? 'Заблокировать ' + CHAT_INFO.name + '? Этот человек больше не сможет вам писать.' : 'Block ' + CHAT_INFO.name + '? They will no longer be able to message you.')) return;
          fetch('/messages/' + (CHAT_INFO.blockedByMe ? 'unblock' : 'block') + '/' + CHAT_INFO.otherId, { method: 'POST', headers: { 'Accept': 'application/json' } })
            .then(function(r) { return r.json(); })
            .then(function(d) { if (d && d.ok) { CHAT_INFO.blockedByMe = !!d.blocked; renderInfoMain(); } })
            .catch(function() {});
        }
        else if (a === 'delete-chat') {
          const ru = LANG === 'ru';
          if (!confirm(ru ? 'Удалить чат с ' + CHAT_INFO.name + '? Он исчезнет из вашего списка. У собеседника переписка останется.' : 'Delete the chat with ' + CHAT_INFO.name + '? It leaves your list. The other person keeps it.')) return;
          fetch('/messages/' + CONV_ID + '/delete-chat', { method: 'POST', headers: { 'Accept': 'application/json' } })
            .then(function(r) { return r.json(); })
            .then(function(d) { if (d && d.ok) window.location.href = d.redirect || '/messages'; })
            .catch(function() {});
        }
        else if (a === 'all-members') {
          chatInfoBody.querySelectorAll('[data-extra]').forEach(function(el) { el.hidden = false; });
          const total = (chatInfoData && chatInfoData.memberCount) || CHAT_INFO.memberCount || 0;
          if (chatInfoData && chatInfoData.members.length < total) { act.dataset.action = 'more-members'; act.textContent = LANG === 'ru' ? 'Показать ещё' : 'Show more'; loadMoreMembers(act); }
          else act.remove();
        }
        else if (a === 'more-members') loadMoreMembers(act);
        else if (a === 'more') loadInfoList(act.dataset.kind, act.dataset.before);
        return;
      }
      const tile = e.target.closest('.msg-info-tile');
      if (tile) {
        const items = (chatInfoBody.__items || []).map(function(it) {
          return { kind: it.image_url ? 'image' : 'video', src: it.image_url || it.file_url, name: it.image_url ? it.image_url.split('/').pop() : (it.file_name || 'video.mp4'),
            poster: it.image_placeholder ? 'url(' + it.image_placeholder + ')' : '', caption: (it.content || '').trim() ? linkify(it.content) : '', sender: it.sender_username || '', created: it.created_at };
        });
        openViewerItems(items, parseInt(tile.dataset.index));
        return;
      }
      const link = e.target.closest('.msg-info-link');
      if (link && !e.target.closest('a')) { closeChatInfo(); jumpToMessageDeep(parseInt(link.dataset.msg)); }
    });
  }

  // Reply-quote jump, and the viewer on a picture or a video
  if (chatEl) {
    chatEl.addEventListener('click', function(e) {
      const quote = e.target.closest('.msg-reply-quote');
      if (quote) {
        jumpToMessage(parseInt(quote.dataset.target));
        return;
      }
      const wrap = e.target.closest('.msg-media');
      if (wrap) openViewer(wrap);
    });
  }

  // A video in the chat shows its length once the metadata is in; it plays in the viewer.
  function fmtDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  if (chatEl) {
    chatEl.addEventListener('loadedmetadata', function(e) {
      const v = e.target;
      if (!v || !v.classList || !v.classList.contains('msg-bubble-video')) return;
      const badge = v.parentElement && v.parentElement.querySelector('.msg-video-badge');
      if (badge) badge.textContent = fmtDuration(v.duration);
    }, true);
    chatEl.addEventListener('play', function(e) {
      const wrap = e.target && e.target.closest && e.target.closest('.msg-bubble-video-wrap');
      if (wrap) wrap.classList.add('is-playing');
    }, true);
    ['pause', 'ended'].forEach(function(name) {
      chatEl.addEventListener(name, function(e) {
        const wrap = e.target && e.target.closest && e.target.closest('.msg-bubble-video-wrap');
        if (wrap) wrap.classList.remove('is-playing');
      }, true);
    });
  }

  // Audio cards share one player: starting a card stops whichever was playing.
  let audioPlayer = null, audioCard = null;
  function audioReset(card) {
    if (!card) return;
    card.classList.remove('is-playing');
    const fill = card.querySelector('.msg-audio-fill'); if (fill) fill.style.width = '0';
    const t = card.querySelector('.msg-audio-time');
    if (t && audioPlayer && isFinite(audioPlayer.duration)) t.textContent = fmtDuration(audioPlayer.duration);
  }
  function audioTick() {
    if (!audioCard || !audioPlayer) return;
    const d = audioPlayer.duration, c = audioPlayer.currentTime;
    const fill = audioCard.querySelector('.msg-audio-fill');
    if (fill && isFinite(d) && d > 0) fill.style.width = Math.round(100 * c / d) + '%';
    const t = audioCard.querySelector('.msg-audio-time');
    if (t) t.textContent = fmtDuration(c) + (isFinite(d) ? ' / ' + fmtDuration(d) : '');
  }
  if (chatEl) {
    chatEl.addEventListener('click', function(e) {
      const card = e.target.closest('.msg-audio');
      if (!card) return;
      const bar = e.target.closest('.msg-audio-bar');
      if (bar && card === audioCard && audioPlayer && isFinite(audioPlayer.duration)) {
        const r = bar.getBoundingClientRect();
        audioPlayer.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audioPlayer.duration;
        audioTick();
        return;
      }
      if (!e.target.closest('.msg-audio-play') && !bar) return;
      if (!audioPlayer) {
        audioPlayer = new Audio();
        audioPlayer.preload = 'metadata';
        audioPlayer.addEventListener('timeupdate', audioTick);
        audioPlayer.addEventListener('loadedmetadata', audioTick);
        audioPlayer.addEventListener('play', function() { if (audioCard) audioCard.classList.add('is-playing'); });
        audioPlayer.addEventListener('pause', function() { if (audioCard) audioCard.classList.remove('is-playing'); });
        audioPlayer.addEventListener('ended', function() { audioReset(audioCard); });
        audioPlayer.addEventListener('error', function() { if (audioCard) { const t = audioCard.querySelector('.msg-audio-time'); if (t) t.textContent = LANG === 'ru' ? 'не удалось воспроизвести' : 'cannot be played'; audioCard.classList.remove('is-playing'); } });
      }
      if (card === audioCard) {
        if (audioPlayer.paused) { const p = audioPlayer.play(); if (p && p.catch) p.catch(function() {}); }
        else audioPlayer.pause();
        return;
      }
      if (audioCard) { audioPlayer.pause(); audioReset(audioCard); }
      audioCard = card;
      audioPlayer.src = card.dataset.src;
      const p = audioPlayer.play();
      if (p && p.catch) p.catch(function() {});
    });
  }

  // A video the browser cannot decode (an iPhone's HEVC in Firefox, say) shows as the download
  // card it would have been anyway. 'error' does not bubble: listen in the capture phase.
  if (chatEl) {
    chatEl.addEventListener('error', function(e) {
      const video = e.target;
      if (!video || !video.classList || !video.classList.contains('msg-bubble-video')) return;
      const wrap = video.closest('.msg-bubble-video-wrap');
      if (!wrap) return;
      const row = wrap.closest('.msg-bubble-row');
      const bubble = wrap.closest('.msg-bubble');
      const time = wrap.querySelector('.msg-bubble-time');
      if (row) row.classList.remove('has-media');
      if (bubble) bubble.classList.remove('has-media');
      const caption = bubble && bubble.querySelector('.msg-caption');
      if (caption) caption.replaceWith.apply(caption, Array.prototype.slice.call(caption.childNodes));
      const card = document.createElement('span');
      card.innerHTML = renderFileCardHTML({ file_url: video.getAttribute('src'), file_name: video.dataset.name, file_size: Number(video.dataset.size) || 0 });
      const anchor = bubble && (bubble.querySelector('.msg-bubble-edited') || bubble.querySelector('.msg-reaction-add'));
      wrap.remove();
      if (bubble) {
        bubble.insertBefore(card.firstChild, anchor);
        if (time) bubble.insertBefore(time, bubble.querySelector('.msg-reaction-add'));   // after the card, as elsewhere
      }
    }, true);
  }

  // Fade chat images in once they finish loading (and catch already-cached ones).
  function markImageLoaded(img) {
    if (img && img.complete && img.naturalWidth > 0) img.classList.add('loaded');
  }
  function markLoadedImages(container) {
    (container || chatEl || document).querySelectorAll('.msg-bubble-image').forEach(markImageLoaded);
  }
  if (chatEl) {
    // 'load' doesn't bubble — listen in the capture phase.
    chatEl.addEventListener('load', function(e) {
      const t = e.target;
      if (t && t.classList && t.classList.contains('msg-bubble-image')) t.classList.add('loaded');
    }, true);
    markLoadedImages(chatEl);
  }

  /* fetch() reports nothing while a body goes up; XMLHttpRequest does. Resolves with the same
     shape the send's handlers read from a fetch Response (ok, status, text(), json()). */
  function uploadWithProgress(url, formData, onProgress) {
    return new Promise(function(resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.addEventListener('progress', function(e) {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      });
      xhr.onload = function() {
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          text: function() { return Promise.resolve(xhr.responseText); },
          json: function() {
            try { return Promise.resolve(JSON.parse(xhr.responseText)); } catch (e) { return Promise.reject(e); }
          },
        });
      };
      xhr.onerror = function() { reject(new TypeError('Network request failed')); };
      xhr.onabort = function() { reject(new TypeError('Upload aborted')); };
      xhr.send(formData);
    });
  }

  function sendMessage() {
    const content = msgInput.value.trim();
    const items = pendingQueue;
    if ((!content && !items.length) || !CONV_ID) return;

    sendBtn.disabled = true;
    msgInput.value = '';
    msgInput.style.height = 'auto';
    /* The saved draft is NOT cleared here. It used to be — the composer and the
       localStorage copy were both wiped before the request was even issued, and the
       only failure handler was console.error. So when the network dropped mid-send the
       text was simply gone: "написал сообщение по каждому пункту, но пропал интернет и
       ничего не отправилось :(((". It is cleared once the server has the message. */

    const replyData = replyingTo; // capture before it is cleared below
    const asFile = pendingAsFile;

    // Clear attachment + reply state
    pendingQueue = [];
    pendingAsFile = false;
    cancelReply();
    if (fileInput) fileInput.value = '';

    if (!items.length) {
      dispatchMessage(stagePendingBubble(content, null, replyData, false));
      return;
    }
    /* Every attachment is its own message. The bubbles all appear now, in the order chosen,
       and the uploads go one after another so they arrive in that order too; the caption and
       the reply go with the last, so the text sits under the pictures as under a Telegram
       album (on the first it landed between them, the owner, 2026-09-21). */
    const last = items.length - 1;
    const jobs = items.map(function(it, index) {
      return stagePendingBubble(index === last ? content : '', it, index === last ? replyData : null, asFile);
    });
    jobs.reduce(function(chain, job) {
      return chain.then(function() { return dispatchMessage(job); });
    }, Promise.resolve());
  }

  /* Draw the bubble of a message about to be sent and return the job that sends it.
     A client-side id, so this particular bubble can be found again when the request
     resolves. Without one, a failed send left a bubble that looked delivered forever:
     the id-0 rows are only reaped by a *successful* later poll. */
  function stagePendingBubble(content, attachment, replyData, asFile) {
    const localImageUrl = (attachment && attachment.isImage && !asFile) ? attachment.url : null;
    const localFile = (attachment && !localImageUrl) ? attachment.file : null;
    const pendingKey = 'p' + (++pendingSeq);
    appendMessage({
      id: 0,
      content: content,
      sender_id: USER_ID,
      sender_username: USERNAME,
      created_at: new Date().toISOString(),
      image_url: localImageUrl,
      image_width: localImageUrl ? (attachment.w || null) : null,
      image_height: localImageUrl ? (attachment.h || null) : null,
      file_url: localFile ? '#' : null,
      file_name: localFile ? attachment.name : null,
      file_size: localFile ? localFile.size : null,
      reply: replyData,
    });
    const pendingRow = chatEl
      ? Array.prototype.slice.call(chatEl.querySelectorAll('[data-msg-id="0"]')).pop()
      : null;
    if (pendingRow) pendingRow.dataset.pendingKey = pendingKey;
    return { content: content, attachment: attachment, replyData: replyData, asFile: asFile, pendingKey: pendingKey, pendingRow: pendingRow };
  }

  /* Send one job. Resolves whatever happens: a failure marks the bubble unsent and the
     next attachment in a batch still goes. */
  function dispatchMessage(job) {
    const content = job.content, replyData = job.replyData, pendingRow = job.pendingRow, pendingKey = job.pendingKey;
    let request;
    if (job.attachment) {
      const fd = new FormData();
      fd.append('content', content);
      fd.append('file', job.attachment.file, job.attachment.name || job.attachment.file.name);
      if (job.asFile) fd.append('as_document', '1');
      if (replyData) fd.append('reply_to_id', replyData.id);
      /* A video can be 100 MB: the pending card shows how much has gone up. */
      request = uploadWithProgress('/messages/' + CONV_ID + '/send', fd, function(loaded, total) {
        if (!pendingRow) return;
        const fill = pendingRow.querySelector('.msg-upload-bar-fill');
        if (fill) fill.style.width = Math.round(100 * loaded / total) + '%';
        const size = pendingRow.querySelector('.msg-bubble-file-size');
        if (size) size.textContent = formatBytes(loaded) + ' / ' + formatBytes(total);
      });
    } else {
      request = fetch('/messages/' + CONV_ID + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ content: content, reply_to_id: replyData ? replyData.id : undefined }),
      });
    }

    return request
    .then(function(r) {
      /* r.json() used to be called unconditionally. A 403 "Not a member", a 500 or a
         429 from the rate limiter are all sent as plain text, so parsing them threw
         into the silent catch below and the message looked sent. */
      if (!r.ok) {
        return r.text().then(function(t) {
          const err = new Error(t || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        });
      }
      return r.json().catch(function() { return {}; });
    })
    .then(function() {
      /* Only drop the stored draft if it is still the text that was just delivered —
         the person may have started typing the next message while this one was in
         flight, and that text is now what the draft holds. */
      let stored = null;
      try { stored = localStorage.getItem(draftKey()); } catch (e) {}
      if (stored === null || stored.trim() === content) clearDraft();
      clearFailed(pendingKey);
      pollMessages();
      refreshConvList();
    })
    .catch(function(err) {
      console.error('Send error:', err);
      markSendFailed(pendingKey, content, err);
    });
  }

  /* ── Unsent messages ───────────────────────────────────────────────────────
     A send that does not arrive keeps its text. The bubble says so and offers to
     try again, the composer gets the words back if it is empty, and anything still
     unsent is retried when the connection returns. Attachments are not queued —
     a File cannot be revived from localStorage — so those are handed straight back
     to the composer instead. */
  let pendingSeq = 0;
  const FAILED_KEY = 'msgFailed:' + (typeof CONV_ID !== 'undefined' ? CONV_ID : '0');
  const FAILED_MAX = 20;

  function readFailed() {
    try { return JSON.parse(localStorage.getItem(FAILED_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeFailed(list) {
    try { localStorage.setItem(FAILED_KEY, JSON.stringify(list.slice(-FAILED_MAX))); } catch (e) {}
  }
  function clearFailed(key) {
    const list = readFailed().filter(function(x) { return x.key !== key; });
    if (list.length) writeFailed(list); else { try { localStorage.removeItem(FAILED_KEY); } catch (e) {} }
  }

  function markSendFailed(key, content, err) {
    const row = chatEl && chatEl.querySelector('[data-pending-key="' + key + '"]');
    if (row) {
      row.classList.add('msg-unsent');
      if (!row.querySelector('.msg-unsent-note')) {
        const note = document.createElement('div');
        note.className = 'msg-unsent-note';
        const label = document.createElement('span');
        /* A refusal that says why (403 with a JSON error, the posting block) shows its reason. */
        let reason = null;
        if (err && err.status === 403 && err.message) {
          try { reason = JSON.parse(err.message).error || null; } catch (e) {}
        }
        label.textContent = reason
          ? reason
          : (err && err.status && err.status !== 0)
            ? (LANG === 'ru' ? 'Не отправлено' : 'Not sent')
            : (LANG === 'ru' ? 'Не отправлено — нет связи' : 'Not sent — no connection');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'msg-unsent-retry';
        retry.textContent = LANG === 'ru' ? 'Повторить' : 'Retry';
        retry.addEventListener('click', function() { retryOne(key); });
        note.appendChild(label);
        note.appendChild(retry);
        row.appendChild(note);
      }
    }
    if (content) {
      const list = readFailed();
      if (!list.some(function(x) { return x.key === key; })) {
        list.push({ key: key, content: content, at: Date.now() });
        writeFailed(list);
      }
      /* If they have not started typing something else, put the words back where
         they can see and edit them. */
      if (msgInput && !msgInput.value.trim()) {
        msgInput.value = content;
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
        saveDraft();
      }
    }
    updateSendEnabled();
  }

  function retryOne(key) {
    const item = readFailed().filter(function(x) { return x.key === key; })[0];
    if (!item) return;
    const row = chatEl && chatEl.querySelector('[data-pending-key="' + key + '"]');
    fetch('/messages/' + CONV_ID + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ content: item.content }),
    })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json().catch(function() { return {}; }); })
    .then(function() {
      clearFailed(key);
      if (row) row.remove();
      /* Only drop the composer copy if it is still the text we just delivered. */
      if (msgInput && msgInput.value.trim() === item.content) { msgInput.value = ''; clearDraft(); updateSendEnabled(); }
      pollMessages();
      refreshConvList();
    })
    .catch(function() { /* stays unsent; the note and the queue entry remain */ });
  }

  function flushFailed() {
    readFailed().forEach(function(item) { retryOne(item.key); });
  }

  window.addEventListener('online', flushFailed);

  // ── Reply flow ──────────────────────────────────────────────────────
  // Plain-text of a message with the quote / meta / image chrome stripped.
  function extractMessageText(msgId) {
    const row = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!row) return '';
    const bubble = row.querySelector('.msg-bubble');
    if (!bubble) return '';
    const clone = bubble.cloneNode(true);
    const strip = clone.querySelectorAll('.msg-reply-quote, .msg-bubble-edited, .msg-reaction-add, .msg-media, .msg-bubble-file, .msg-bubble-time, .msg-poll, .msg-forwarded');
    for (let i = 0; i < strip.length; i++) strip[i].remove();
    return clone.textContent.trim();
  }

  function renderReplyQuoteHTML(reply) {
    if (!reply || !reply.id) return '';
    const preview = reply.isImage ? (LANG === 'ru' ? 'Фото' : 'Photo') : (reply.preview || '');
    return '<div class="msg-reply-quote tex2jax_ignore" data-target="' + reply.id + '">' +
      '<div class="msg-reply-quote-name">' + esc(reply.sender || '') + '</div>' +
      '<div class="msg-reply-quote-text">' + esc(preview) + '</div></div>';
  }

  function startReply(msgId) {
    const row = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!row) return;
    if (editingMsgId) cancelEdit();
    const senderName = row.dataset.senderName || '';
    const hasImage = !!row.querySelector('.msg-bubble-image');
    const fileNameEl = row.querySelector('.msg-bubble-file-name');
    const fileName = fileNameEl ? fileNameEl.textContent : '';
    const text = extractMessageText(msgId);
    replyingTo = {
      id: msgId,
      sender: senderName,
      preview: text || fileName,
      isImage: !text && !fileName && hasImage,
      isFile: !text && !!fileName,
    };
    if (replyBarName) replyBarName.textContent = senderName;
    if (replyBarText) {
      replyBarText.textContent = replyingTo.isImage ? (LANG === 'ru' ? 'Фото' : 'Photo') : (text || fileName);
    }
    if (replyBar) replyBar.style.display = 'flex';
    if (msgInput) msgInput.focus();
  }

  function cancelReply() {
    replyingTo = null;
    if (replyBar) replyBar.style.display = 'none';
  }

  // Edit flow
  function startEdit(msgId) {
    const row = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!row) return;
    const bubble = row.querySelector('.msg-bubble');
    if (!bubble) return;
    cancelReply();

    const text = extractMessageText(msgId);

    editingMsgId = msgId;
    msgInput.value = text;
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = false;
    editBar.style.display = 'flex';
    editBarText.textContent = LANG === 'ru' ? 'Редактирование сообщения' : 'Editing message';
    msgInput.focus();
  }

  function cancelEdit() {
    editingMsgId = null;
    msgInput.value = '';
    msgInput.style.height = 'auto';
    editBar.style.display = 'none';
    updateSendEnabled();
  }

  function submitEdit() {
    const content = msgInput.value.trim();
    if (!content || !editingMsgId) return;
    const msgId = editingMsgId;

    sendBtn.disabled = true;

    fetch('/messages/' + msgId + '/edit', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ content: content }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        const row = document.querySelector('[data-msg-id="' + msgId + '"]');
        if (row) {
          const bubble = row.querySelector('.msg-bubble');
          if (bubble) {
            rebuildBubbleText(bubble, msgId, content);
          }
        }
      } else if (data.error) {
        alert(data.error);
      }
      cancelEdit();
    })
    .catch(function(err) {
      console.error('Edit error:', err);
      cancelEdit();
    });
  }

  // Delete flow
  function deleteMessage(msgId) {
    const confirmText = LANG === 'ru' ? 'Удалить это сообщение?' : 'Delete this message?';
    if (!confirm(confirmText)) return;

    fetch('/messages/' + msgId + '/delete', {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' },
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        const row = document.querySelector('[data-msg-id="' + msgId + '"]');
        if (row) {
          row.style.display = 'none';
        }
      } else if (data.error) {
        alert(data.error);
      }
    })
    .catch(function(err) { console.error('Delete error:', err); });
  }

  // Event delegation for reaction buttons
  if (chatEl) {
    chatEl.addEventListener('click', function(e) {
      const pickBtn = e.target.closest('.msg-reaction-pick');
      if (pickBtn) {
        var addEl = pickBtn.closest('.msg-reaction-add');
        var msgId = parseInt(addEl.dataset.msgId);
        // Close on choosing, the way a menu does; leaving the button re-arms it.
        addEl.classList.add('is-dismissed');
        // A premium reaction nobody bought yet opens the shop on it instead.
        if (pickBtn.classList.contains('is-locked') && window.SSApps) {
          window.SSApps.open({ tab: 'shop', rx: pickBtn.dataset.emoji });
          return;
        }
        toggleReaction(msgId, pickBtn.dataset.emoji);
        return;
      }
      const addBtn = e.target.closest('.msg-reaction-add');
      if (addBtn) {
        return;
      }
      const reactionBtn = e.target.closest('.msg-reaction');
      if (reactionBtn && !reactionBtn.classList.contains('msg-reaction-add')) {
        toggleReaction(parseInt(reactionBtn.dataset.msgId), reactionBtn.dataset.emoji);
        return;
      }
    });
  }

  // Right-click context menu for edit/delete
  var ctxMenu = document.getElementById('msgContextMenu');
  var ctxReply = document.getElementById('ctxReply');
  var ctxCopy = document.getElementById('ctxCopy');
  var ctxCopyImage = document.getElementById('ctxCopyImage');
  var ctxSave = document.getElementById('ctxSave');
  var ctxReactions = document.getElementById('ctxReactions');
  var ctxReactionsList = document.getElementById('ctxReactionsList');
  var ctxReactionsMore = document.getElementById('ctxReactionsMore');
  var ctxPin = document.getElementById('ctxPin');
  var ctxPinLabel = document.getElementById('ctxPinLabel');
  var ctxForward = document.getElementById('ctxForward');
  var ctxCopyLink = document.getElementById('ctxCopyLink');
  var ctxReport = document.getElementById('ctxReport');
  var ctxEdit = document.getElementById('ctxEdit');
  var ctxHide = document.getElementById('ctxHide');
  var ctxDelete = document.getElementById('ctxDelete');
  var ctxMsgId = null;

  function openContextMenu(row, x, y) {
    if (!row) return;
    var msgId = parseInt(row.dataset.msgId);
    if (!msgId) return; // optimistic / not-yet-saved bubble — nothing to act on
    var isSent = row.classList.contains('sent');
    var ageH = (Date.now() - new Date(row.dataset.created).getTime()) / 3600000;
    var canEdit = isSent && ageH < 24;
    var senderIsAdmin = row.dataset.senderRole === 'admin';
    var canDelete = (IS_ADMIN || (isSent && ageH < 24)) && !(senderIsAdmin && !isSent);
    var hasText = extractMessageText(msgId).length > 0;
    var isPinned = row.dataset.pinned === '1';
    ctxMsgId = msgId;
    if (ctxReactionsList) {
      fillReactionPicker(ctxReactionsList);
      setReactionsExpanded(false);
      ctxReactionsList.scrollLeft = 0;
    }
    var image = row.querySelector('.msg-bubble-image');
    var saveable = row.querySelector('.msg-bubble-image, .msg-bubble-video, .msg-bubble-file, .msg-audio');
    ctxReply.style.display = '';               // reply is always available
    ctxCopy.style.display = hasText ? '' : 'none';
    if (ctxCopyImage) ctxCopyImage.style.display = (image && navigator.clipboard && window.ClipboardItem) ? '' : 'none';
    if (ctxSave) ctxSave.style.display = saveable ? '' : 'none';
    if (ctxPin) {
      ctxPin.style.display = CAN_PIN ? '' : 'none';
      if (ctxPinLabel) ctxPinLabel.textContent = isPinned
        ? (LANG === 'ru' ? 'Открепить' : 'Unpin')
        : (LANG === 'ru' ? 'Закрепить' : 'Pin');
    }
    if (ctxForward) ctxForward.style.display = '';   // forward is always available
    if (ctxCopyLink) ctxCopyLink.style.display = '';
    if (ctxReport) ctxReport.style.display = isSent ? 'none' : ''; // can't report your own
    ctxEdit.style.display = canEdit ? '' : 'none';
    if (ctxHide) ctxHide.style.display = '';         // "delete for me" is always available
    ctxDelete.style.display = canDelete ? '' : 'none';
    ctxMenu.classList.add('show');
    placeContextMenu(x, y);
  }

  // Keep the menu inside the viewport, at the point asked for or as close as it fits.
  function placeContextMenu(x, y) {
    var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    ctxMenu.style.left = Math.max(8, x) + 'px';
    ctxMenu.style.top = Math.max(8, y) + 'px';
  }

  // The chevron opens the strip into the full grid and back; the menu is moved up if the grid
  // would run off the bottom.
  function setReactionsExpanded(open) {
    if (!ctxReactions) return;
    ctxReactions.classList.toggle('is-expanded', open);
    if (ctxReactionsMore) ctxReactionsMore.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (ctxReactionsMore) {
    ctxReactionsMore.addEventListener('click', function(e) {
      e.stopPropagation(); // the document's click closes the menu
      setReactionsExpanded(!ctxReactions.classList.contains('is-expanded'));
      placeContextMenu(parseFloat(ctxMenu.style.left) || 8, parseFloat(ctxMenu.style.top) || 8);
    });
  }
  // A mouse wheel has no horizontal axis: its turn scrolls the strip sideways.
  if (ctxReactionsList) {
    ctxReactionsList.addEventListener('wheel', function(e) {
      if (ctxReactions.classList.contains('is-expanded')) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // a trackpad already scrolls sideways
      var max = ctxReactionsList.scrollWidth - ctxReactionsList.clientWidth;
      if (max <= 0) return;
      e.preventDefault();
      ctxReactionsList.scrollLeft = Math.max(0, Math.min(max, ctxReactionsList.scrollLeft + e.deltaY));
    }, { passive: false });
  }

  var suppressNextClick = false;

  if (chatEl) {
    // Desktop: right-click.
    chatEl.addEventListener('contextmenu', function(e) {
      var row = e.target.closest('.msg-bubble-row');
      if (!row || !parseInt(row.dataset.msgId)) return;
      e.preventDefault();
      openContextMenu(row, e.clientX, e.clientY);
    });

    // Touch: long-press opens the same menu (right-click doesn't exist on phones).
    var lpTimer = null, lpRow = null, lpX = 0, lpY = 0, lpMoved = false;
    var LP_MS = 500, LP_MOVE = 10;
    function clearLongPress() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      lpRow = null; lpMoved = false;
    }
    chatEl.addEventListener('touchstart', function(e) {
      if (e.touches.length !== 1) { clearLongPress(); return; }
      var row = e.target.closest('.msg-bubble-row');
      if (!row || !parseInt(row.dataset.msgId)) return;
      var t = e.touches[0];
      lpRow = row; lpX = t.clientX; lpY = t.clientY; lpMoved = false;
      lpTimer = setTimeout(function() {
        lpTimer = null;
        if (lpRow && !lpMoved) {
          openContextMenu(lpRow, lpX, lpY);
          suppressNextClick = true; // swallow the tap that follows the long-press
        }
      }, LP_MS);
    }, { passive: true });
    chatEl.addEventListener('touchmove', function(e) {
      if (!lpRow || !e.touches.length) return;
      var t = e.touches[0];
      if (Math.abs(t.clientX - lpX) > LP_MOVE || Math.abs(t.clientY - lpY) > LP_MOVE) {
        clearLongPress();
      }
    }, { passive: true });
    chatEl.addEventListener('touchend', clearLongPress);
    chatEl.addEventListener('touchcancel', clearLongPress);

    // Capture phase: eat the synthetic click after a long-press so it doesn't
    // open the image lightbox / jump a reply / close the menu immediately.
    chatEl.addEventListener('click', function(e) {
      if (suppressNextClick) {
        suppressNextClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  document.addEventListener('click', function() {
    ctxMenu.classList.remove('show');
  });

  document.addEventListener('contextmenu', function(e) {
    if (!e.target.closest('.msg-bubble-row')) {
      ctxMenu.classList.remove('show');
    }
  });

  ctxReply.addEventListener('click', function() {
    if (ctxMsgId) startReply(ctxMsgId);
    ctxMenu.classList.remove('show');
  });

  ctxCopy.addEventListener('click', function() {
    if (ctxMsgId) {
      var t = extractMessageText(ctxMsgId);
      if (t && navigator.clipboard) navigator.clipboard.writeText(t).catch(function() {});
    }
    ctxMenu.classList.remove('show');
  });

  // A reaction from the strip: the same as picking one from the button's picker.
  if (ctxReactions) {
    ctxReactions.addEventListener('click', function(e) {
      var pick = e.target.closest('.msg-reaction-pick');
      if (!pick || !ctxMsgId) return;
      ctxMenu.classList.remove('show');
      if (pick.classList.contains('is-locked') && window.SSApps) { window.SSApps.open({ tab: 'shop', rx: pick.dataset.emoji }); return; }
      toggleReaction(ctxMsgId, pick.dataset.emoji);
    });
  }

  // The file behind a message, with the name it was sent under.
  function attachmentOf(row) {
    var img = row.querySelector('.msg-bubble-image');
    if (img) return { url: img.dataset.full || img.src, name: (img.dataset.full || img.src).split('/').pop() };
    var video = row.querySelector('.msg-bubble-video');
    if (video) return { url: video.getAttribute('src'), name: video.dataset.name || 'video.mp4' };
    var audio = row.querySelector('.msg-audio');
    if (audio) return { url: audio.dataset.src, name: audio.dataset.name || 'audio' };
    var file = row.querySelector('.msg-bubble-file');
    if (file && file.getAttribute('href') !== '#') return { url: file.getAttribute('href'), name: file.getAttribute('download') || 'file' };
    return null;
  }

  if (ctxSave) {
    ctxSave.addEventListener('click', function() {
      var row = ctxMsgId && document.querySelector('[data-msg-id="' + ctxMsgId + '"]');
      var a = row && attachmentOf(row);
      ctxMenu.classList.remove('show');
      if (!a) return;
      var link = document.createElement('a');
      link.href = a.url; link.download = a.name;
      document.body.appendChild(link); link.click(); link.remove();
    });
  }

  // Copy a picture to the clipboard as PNG (the only image type the clipboard takes).
  if (ctxCopyImage) {
    ctxCopyImage.addEventListener('click', function() {
      var row = ctxMsgId && document.querySelector('[data-msg-id="' + ctxMsgId + '"]');
      var img = row && row.querySelector('.msg-bubble-image');
      ctxMenu.classList.remove('show');
      if (!img || !navigator.clipboard || !window.ClipboardItem) return;
      var src = img.dataset.full || img.src;
      var blobPromise = fetch(src).then(function(r) { return r.blob(); }).then(function(blob) {
        if (blob.type === 'image/png') return blob;
        return new Promise(function(resolve, reject) {
          var image = new Image();
          image.onload = function() {
            var c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
            c.getContext('2d').drawImage(image, 0, 0);
            c.toBlob(function(b) { b ? resolve(b) : reject(new Error('no png')); }, 'image/png');
          };
          image.onerror = reject;
          image.src = URL.createObjectURL(blob);
        });
      });
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]).catch(function() {});
    });
  }

  if (ctxPin) {
    ctxPin.addEventListener('click', function() {
      if (ctxMsgId) togglePin(ctxMsgId);
      ctxMenu.classList.remove('show');
    });
  }

  if (ctxForward) {
    ctxForward.addEventListener('click', function() {
      if (ctxMsgId) openForwardModal(ctxMsgId);
      ctxMenu.classList.remove('show');
    });
  }

  if (ctxCopyLink) {
    ctxCopyLink.addEventListener('click', function() {
      if (ctxMsgId && CONV_ID) {
        var url = location.origin + '/' + LANG + '/messages/' + CONV_ID + '#msg-' + ctxMsgId;
        if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function() {});
      }
      ctxMenu.classList.remove('show');
    });
  }

  if (ctxReport) {
    ctxReport.addEventListener('click', function() {
      var id = ctxMsgId;
      ctxMenu.classList.remove('show');
      if (!id) return;
      var reason = prompt(LANG === 'ru' ? 'Причина жалобы (необязательно):' : 'Reason for report (optional):');
      if (reason === null) return; // cancelled
      fetch('/messages/' + id + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ reason: reason }),
      })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          alert(d.error ? d.error : (LANG === 'ru' ? 'Жалоба отправлена.' : 'Report submitted.'));
        })
        .catch(function() {});
    });
  }

  if (ctxHide) {
    ctxHide.addEventListener('click', function() {
      var id = ctxMsgId;
      ctxMenu.classList.remove('show');
      if (!id) return;
      if (!confirm(LANG === 'ru' ? 'Удалить это сообщение только у себя?' : 'Delete this message for yourself only?')) return;
      fetch('/messages/' + id + '/hide', { method: 'POST', headers: { 'Accept': 'application/json' } })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.error) { alert(d.error); return; }
          var row = document.querySelector('.msg-bubble-row[data-msg-id="' + id + '"]');
          if (row) row.remove();
        })
        .catch(function() {});
    });
  }

  // ── Forward ─────────────────────────────────────────────────────────
  const forwardModal = document.getElementById('forwardModal');
  const forwardClose = document.getElementById('forwardClose');
  const forwardSearch = document.getElementById('forwardSearch');
  const forwardResults = document.getElementById('forwardResults');
  const forwardTargets = document.getElementById('forwardTargets');
  let forwardMsgId = null;

  function openForwardModal(msgId) {
    forwardMsgId = msgId;
    if (forwardSearch) forwardSearch.value = '';
    if (forwardResults) forwardResults.innerHTML = '';
    if (forwardModal) forwardModal.classList.add('show');
    if (forwardSearch) forwardSearch.focus();
  }
  function closeForwardModal() {
    if (forwardModal) forwardModal.classList.remove('show');
    forwardMsgId = null;
  }
  function doForward(payload) {
    if (!forwardMsgId) return;
    payload.messageId = forwardMsgId;
    fetch('/messages/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { alert(data.error); return; }
        if (data.conversationId) window.location.href = '/' + LANG + '/messages/' + data.conversationId;
      })
      .catch(function() {});
  }

  if (forwardClose) forwardClose.addEventListener('click', closeForwardModal);
  if (forwardModal) {
    forwardModal.addEventListener('click', function(e) {
      if (e.target === forwardModal) closeForwardModal();
    });
  }
  if (forwardTargets) {
    forwardTargets.addEventListener('click', function(e) {
      const a = e.target.closest('.msg-user-result');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.saved) doForward({ toSaved: true });
      else if (a.dataset.convId) doForward({ toConversationId: parseInt(a.dataset.convId) });
    });
  }
  let forwardSearchTimer = null;
  if (forwardSearch) {
    forwardSearch.addEventListener('input', function() {
      clearTimeout(forwardSearchTimer);
      const q = this.value.trim();
      if (q.length < 2) { forwardResults.innerHTML = ''; return; }
      forwardSearchTimer = setTimeout(function() {
        fetch('/messages/search-users?q=' + encodeURIComponent(q))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            forwardResults.innerHTML = '';
            (data.users || []).forEach(function(u) {
              const el = document.createElement('div');
              el.className = 'msg-user-result';
              el.style.cursor = 'pointer';
              el.innerHTML =
                '<img src="' + esc(u.profile_picture || '/img/profile_images/Default_placeholder.svg') + '" alt="" />' +
                '<div><div class="msg-user-result-name">' + esc(u.username) + '</div>' +
                (u.full_name ? '<div class="msg-user-result-full">' + esc(u.full_name) + '</div>' : '') +
                '</div>';
              el.addEventListener('click', function() { doForward({ toUserId: u.id }); });
              forwardResults.appendChild(el);
            });
          });
      }, 300);
    });
  }

  ctxEdit.addEventListener('click', function() {
    if (ctxMsgId) startEdit(ctxMsgId);
    ctxMenu.classList.remove('show');
  });

  ctxDelete.addEventListener('click', function() {
    if (ctxMsgId) deleteMessage(ctxMsgId);
    ctxMenu.classList.remove('show');
  });

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function linkify(text) {
    var html = esc(text);
    // Protect code so its content isn't linkified/formatted (mirrors the server).
    var codes = [];
    var ph = function(i) { return 'zXcodeXz' + i + 'zXcodeXz'; };
    html = html.replace(/```\n?([\s\S]*?)```/g, function(m, c) {
      codes.push('<pre class="msg-code"><code>' + c.replace(/\n$/, '') + '</code></pre>');
      return ph(codes.length - 1);
    });
    html = html.replace(/`([^`\n]+?)`/g, function(m, c) {
      codes.push('<code class="msg-code-inline">' + c + '</code>');
      return ph(codes.length - 1);
    });
    // Link colour via --auto-link-color, as on the server (AUTO_LINK_COLOR in utils.js).
    html = html.replace(/(?:https?:\/\/)[^\s<>"']+/g, function(url) {
      var clean = url.replace(/[.,;:!?)]+$/, '');
      var trailing = url.slice(clean.length);
      return '<a href="' + clean + '" target="_blank" rel="noopener noreferrer" style="color:var(--auto-link-color,#1a5276);text-decoration:underline;">' + clean + '</a>' + trailing;
    });
    html = html.replace(/(?<![&\w])@([a-zA-Z0-9_]{2,30})(?![^<]*<\/a>)/g,
      function(_, name) { return '<a href="/user/' + name + '" class="user-mention ' + rankClassFor(name) + '" data-no-rank>' + name + '</a>'; });
    html = html.replace(/(?<![&\w])#(\d{1,2}\.\d{1,2}\.\d{1,3})(?![^<]*<\/a>)/g,
      '<a href="/' + LANG + '/$1" class="problem-ref" style="color:var(--auto-link-color,#1a5276);font-weight:var(--ss-fw-regular);text-decoration:none;">#$1</a>');
    html = html.replace(/\*\*([^\n*][^*]*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/zXcodeXz(\d+)zXcodeXz/g, function(m, i) { return codes[parseInt(i, 10)]; });
    return html;
  }

  function fmtTime(dateStr) {
    return new Date(dateStr).toLocaleTimeString(TIME_LOCALE, { hour: '2-digit', minute: '2-digit' });
  }

  // The server wrote the times in the zone its cookie named. When that is this browser's zone
  // there is nothing to redo; otherwise (a first visit, a reader who travelled) they are
  // rewritten here, and the receipts stay in place because only the time's text changes.
  // The sidebar's time for a chat: the time today, the weekday this week, else the date.
  function convTimeText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diff = now - d;
    if (diff < 86400000 && d.getDate() === now.getDate()) return d.toLocaleTimeString(TIME_LOCALE, { hour: '2-digit', minute: '2-digit' });
    if (diff < 604800000) return d.toLocaleDateString(TIME_LOCALE, { weekday: 'short' });
    return d.toLocaleDateString(TIME_LOCALE, { month: 'short', day: 'numeric' });
  }
  function localizeSsrTimes() {
    const body = document.querySelector('.msg-body');
    if (!TIMES_ARE_LOCAL) {
      document.querySelectorAll('.msg-bubble-time[data-iso]').forEach(el => {
        const iso = el.getAttribute('data-iso');
        if (!iso) return;
        const d = new Date(iso);
        if (isNaN(d.getTime())) return;
        const check = el.querySelector('.msg-check');
        el.textContent = d.toLocaleTimeString(TIME_LOCALE, { hour: '2-digit', minute: '2-digit' });
        if (check) el.appendChild(check);
      });
      document.querySelectorAll('.msg-conv-time[data-iso]').forEach(el => {
        const out = convTimeText(el.getAttribute('data-iso'));
        if (out) el.textContent = out;
      });
    }
    if (body) body.classList.remove('msg-times-utc');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', localizeSsrTimes);
  } else {
    localizeSsrTimes();
  }

  // Serialize dynamic typesetting through MathJax's startup promise so bubbles
  // that arrive before/while MathJax loads still get rendered, in order.
  function typesetMath(el) {
    if (!el || !window.MathJax || !MathJax.startup || !MathJax.startup.promise) return;
    MathJax.startup.promise = MathJax.startup.promise
      .then(function() { return MathJax.typesetPromise([el]); })
      .catch(function(err) { console.error('MathJax typeset error:', err); });
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderForwardedHTML(m) {
    if (!m.forwarded_from_username) return '';
    return '<div class="msg-forwarded tex2jax_ignore">' + (LANG === 'ru' ? 'Переслано от' : 'Forwarded from') +
      ' <a href="/user/' + encodeURIComponent(m.forwarded_from_username) + '">' + esc(m.forwarded_from_username) + '</a></div>';
  }

  // What a message shows inline: 'image', 'video' (converted and ready), or null.
  function mediaKindOf(m) {
    if (m.image_url) return 'image';
    if (m.file_url && m.file_url !== '#' && attachmentKind(m.file_name) === 'video' && !m.attachment_status) return 'video';
    return null;
  }
  // Telegram Desktop's box: 430 × 430 at most, never upscaled (the template's mediaBox).
  function mediaBox(w, h) {
    if (!(w > 0 && h > 0)) return null;
    return { width: Math.max(1, Math.min(w, 430, Math.round(430 * w / h))), w: w, h: h };
  }
  const PLAY_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
  function renderMediaHTML(m, kind, timeHtml) {
    const box = mediaBox(m.image_width, m.image_height);
    let style = box ? 'width:' + box.width + 'px;aspect-ratio:' + box.w + '/' + box.h + ';' : '';
    if (m.image_placeholder) style += 'background-image:url(' + m.image_placeholder + ');';
    const cls = 'msg-media ' + (kind === 'image' ? 'msg-bubble-image-wrap' : 'msg-bubble-video-wrap') + (box ? ' has-dims' : '');
    const inner = kind === 'image'
      ? '<img class="msg-bubble-image" src="' + esc(m.image_url) + '" data-full="' + esc(m.image_url) + '" alt="" loading="lazy" />'
      : '<video class="msg-bubble-video" src="' + esc(m.file_url) + '" preload="metadata" playsinline' +
        ' data-name="' + escAttr(m.file_name || '') + '" data-size="' + (Number(m.file_size) || 0) + '"></video>' +
        '<span class="msg-video-badge"></span><span class="msg-video-play">' + PLAY_SVG + '</span>';
    return '<span class="' + cls + '" style="' + style + '">' + inner + (timeHtml || '') + '</span>';
  }

  function renderFileCardHTML(m) {
    if (!m.file_url) return '';
    const icon = '<span class="msg-bubble-file-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>';
    let size = m.file_size ? formatBytes(m.file_size) : '';
    if (m.attachment_status === 'converting') size += (LANG === 'ru' ? ' · конвертируем видео…' : ' · converting the video…');
    const pending = m.file_url === '#';
    const href = pending ? '#' : esc(m.file_url);
    return '<a class="msg-bubble-file tex2jax_ignore" href="' + href + '" download="' + escAttr(m.file_name || '') + '">' +
      icon +
      '<span class="msg-bubble-file-meta"><span class="msg-bubble-file-name">' + esc(m.file_name || 'file') + '</span>' +
      '<span class="msg-bubble-file-size">' + esc(size) + '</span>' +
      (pending ? '<span class="msg-upload-bar"><span class="msg-upload-bar-fill"></span></span>' : '') +
      '</span></a>';
  }

  function renderAudioHTML(m) {
    return '<span class="msg-audio" data-src="' + escAttr(m.file_url) + '" data-name="' + escAttr(m.file_name || '') + '">' +
      '<button type="button" class="msg-audio-play" aria-label="' + (LANG === 'ru' ? 'Слушать' : 'Play') + '">' +
      '<svg class="msg-audio-play-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>' +
      '<svg class="msg-audio-pause-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg></button>' +
      '<span class="msg-audio-meta"><span class="msg-audio-name">' + esc(m.file_name || 'audio') + '</span>' +
      '<span class="msg-audio-time">' + esc(m.file_size ? formatBytes(m.file_size) : '') + '</span>' +
      '<span class="msg-audio-bar"><span class="msg-audio-fill"></span></span></span></span>';
  }
  // A download card, or the player for an audio file that is ready.
  function renderAttachmentCardHTML(m) {
    if (m.file_url && m.file_url !== '#' && attachmentKind(m.file_name) === 'audio' && !m.attachment_status) return renderAudioHTML(m);
    return renderFileCardHTML(m);
  }

  // The inside of a bubble: forwarded line, reply quote, then the picture or video with the
  // text as its caption, or the text and a download card. `timeHtml` goes onto the picture of
  // a media-only message. `textHtml` is already safe HTML.
  function bubbleInnerHTML(m, textHtml, timeHtml) {
    const kind = mediaKindOf(m);
    const hasText = !!textHtml;
    const edited = m.edited_at ? '<span class="msg-bubble-edited">' + esc(LANG === 'ru' ? ' (ред.)' : ' (edited)') + '</span>' : '';
    let html = renderForwardedHTML(m) + renderReplyQuoteHTML(m.reply);
    if (kind) {
      /* A figure over a poll: the picture, the poll, then the caption with the time. */
      html += renderMediaHTML(m, kind, hasText || m.poll ? '' : timeHtml);
      if (m.poll) html += '<div class="msg-poll"></div>';
      if (hasText) html += '<span class="msg-caption">' + textHtml + edited + timeHtml + '</span>';
      else if (m.poll) html += edited + timeHtml;
    } else {
      html += (m.poll ? '<div class="msg-poll"></div>' : '') + textHtml + renderAttachmentCardHTML(m) + edited + timeHtml;
    }
    html += renderReactionAddHTML(m.id);
    return html;
  }

  // After an edit: the same bubble with new text, keeping what it showed.
  function rebuildBubbleText(bubble, msgId, content) {
    const keep = function(sel) { const el = bubble.querySelector(sel); return el ? el.outerHTML : ''; };
    const mediaEl = bubble.querySelector('.msg-media');
    const timeEl = bubble.querySelector('.msg-bubble-time');
    const timeInMedia = !!(mediaEl && timeEl && mediaEl.contains(timeEl));
    const mediaHtml = keep('.msg-media');
    const timeHtml = timeInMedia ? '' : (timeEl ? timeEl.outerHTML : '');
    const edited = '<span class="msg-bubble-edited">' + esc(LANG === 'ru' ? ' (ред.)' : ' (edited)') + '</span>';
    const textHtml = esc(content);
    bubble.innerHTML = keep('.msg-forwarded') + keep('.msg-reply-quote') + mediaHtml + keep('.msg-poll') +
      (mediaHtml ? '<span class="msg-caption">' + textHtml + edited + timeHtml + '</span>'
                 : textHtml + keep('.msg-bubble-file') + keep('.msg-audio') + edited + timeHtml) +
      renderReactionAddHTML(msgId);
    typesetMath(bubble);
    markLoadedImages(bubble);
  }

  // Days are the reader's own, in the browser's time zone: a message sent at 01:30 in Moscow
  // belongs under that day, not under the day before, which it was in UTC.
  function clientDayKey(iso) {
    const d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function clientDaySepText(iso) {
    return new Date(iso).toLocaleDateString(LANG === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // The server draws the separators by the reader's day when it knows the zone (the ss_tz
  // cookie); when it did not, or the browser's zone differs, redraw them here, before anything
  // on the page is measured or scrolled to.
  function regroupDaySeparators() {
    if (!chatEl || TIMES_ARE_LOCAL) return;
    chatEl.querySelectorAll('.msg-date-sep').forEach(function (el) { el.remove(); });
    let last = null;
    chatEl.querySelectorAll('.msg-bubble-row[data-created]').forEach(function (row) {
      if (row.parentNode !== chatEl) return;
      const key = clientDayKey(row.dataset.created);
      if (key === last) return;
      last = key;
      const prev = row.previousElementSibling;
      const before = prev && prev.classList.contains('msg-new-divider') ? prev : row;
      chatEl.insertBefore(makeDateSep(row.dataset.created), before);
    });
  }
  function makeDateSep(iso) {
    const el = document.createElement('div');
    el.className = 'msg-date-sep';
    el.dataset.date = clientDayKey(iso);
    el.textContent = clientDaySepText(iso);
    return el;
  }
  function checkSpanHTML(isRead) {
    if (isRead) {
      return '<span class="msg-check read"><svg viewBox="0 0 20 12" width="17" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6.5l3.2 3.4L10 2.4"/><path d="M8 6.5l3.2 3.4L17 2.4"/></svg></span>';
    }
    return '<span class="msg-check"><svg viewBox="0 0 14 12" width="13" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5l3.2 3.4L11.5 2.4"/></svg></span>';
  }
  function isReadAt(iso) {
    return !!readCutoff && new Date(iso) <= new Date(readCutoff);
  }

  // Re-evaluate the read/unread check on sent bubbles. Only touches the DOM for
  // messages whose read-state actually changed — re-writing every check on each
  // poll caused the icons to flicker/disappear during momentum scroll on iOS.
  function updateAllReceipts() {
    if (!SHOW_RECEIPTS || !chatEl) return;
    chatEl.querySelectorAll('.msg-bubble-row.sent').forEach(function(row) {
      const timeEl = row.querySelector('.msg-bubble-time');
      if (!timeEl || !row.dataset.created) return;
      const wantRead = isReadAt(row.dataset.created);
      const existing = timeEl.querySelector('.msg-check');
      if (existing && existing.classList.contains('read') === wantRead) return; // unchanged
      if (existing) existing.remove();
      timeEl.insertAdjacentHTML('beforeend', checkSpanHTML(wantRead));
    });
  }

  // Build a message row element (no DOM insertion). Shared by appendMessage
  // (bottom) and prependHistory (top).
  function buildMessageRow(m) {
    const isSent = m.sender_id === USER_ID;
    const isEdited = !!m.edited_at;
    const row = document.createElement('div');
    row.className = 'msg-bubble-row ' + (isSent ? 'sent' : 'received');
    row.dataset.msgId = m.id || 0;
    if (m.created_at) row.dataset.created = m.created_at;
    row.dataset.senderRole = m.sender_role || 'member';
    row.dataset.senderName = isSent ? USERNAME : (IS_GROUP ? (m.sender_username || '') : OTHER_NAME);
    if (m.pinned_at) row.dataset.pinned = '1';

    let html = '';
    const senderHref = '/user/' + encodeURIComponent(m.sender_username || '');
    if (!isSent && IS_GROUP) {
      html += '<a href="' + senderHref + '"><img class="msg-bubble-avatar" src="' + esc(m.sender_picture || '/img/profile_images/Default_placeholder.svg') + '" alt="" /></a>';
    }

    html += '<div>';
    if (!isSent && IS_GROUP) {
      const modBadge = m.sender_role === 'admin' ? '<span class="msg-admin-badge">' + (LANG === 'ru' ? 'мод' : 'mod') + '</span>' : '';
      /* A member kept from writing here for now: others see it on their messages (the server
         template does the same); js/local-time.js fills the <time> in the reader's zone. */
      const blockedUntil = m.sender_blocked_until ? new Date(m.sender_blocked_until) : null;
      const suspended = !blockedUntil || !(blockedUntil > new Date()) ? ''
        : blockedUntil.getUTCFullYear() >= 9999   /* PERMANENT_YEAR in lib/chatRestrictions.js */
          ? '<span class="msg-suspended-badge">' + (LANG === 'ru' ? 'не может писать' : 'cannot post') + '</span>'
          : '<span class="msg-suspended-badge">' + (LANG === 'ru' ? 'не может писать до ' : 'cannot post until ')
            + '<time datetime="' + esc(blockedUntil.toISOString()) + '" data-local="daytime" data-lang="' + LANG + '">' + esc(blockedUntil.toLocaleString(TIME_LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</time></span>';
      html += '<div class="msg-bubble-sender"><a href="' + senderHref + '" class="' + rankClassFor(m.sender_username) + '">' + esc(m.sender_username) + '</a>' + modBadge + suspended + '</div>';
    }
    const kind = mediaKindOf(m);
    const textHtml = (m.content || '').trim() ? linkify(m.content) : '';
    if (kind) row.classList.add('has-media');
    const receiptHtml = (isSent && SHOW_RECEIPTS) ? checkSpanHTML(isReadAt(m.created_at)) : '';
    const timeHtml = '<div class="msg-bubble-time">' + fmtTime(m.created_at) + receiptHtml + '</div>';
    html += '<div class="msg-bubble ' + (isSent ? 'sent' : 'received') + (kind ? ' has-media' : '') + '">' + bubbleInnerHTML(m, textHtml, timeHtml) + '</div>';
    html += renderReactionsHTML(m.id, m.reactions || []);
    html += '</div>';

    row.innerHTML = html;
    if (m.poll) renderPoll(row.querySelector('.msg-poll'), m.poll);
    return row;
  }

  function appendMessage(m) {
    if (!chatEl) return;
    if (m.deleted_at) return;
    const row = buildMessageRow(m);

    // Insert a date separator when the day rolls over from the last message.
    const newKey = clientDayKey(m.created_at);
    if (bottomDayKey !== newKey) {
      chatEl.appendChild(makeDateSep(m.created_at));
      bottomDayKey = newKey;
    }

    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;
    const bubbleEl = row.querySelector('.msg-bubble');
    if (bubbleEl) typesetMath(bubbleEl);
    const im = row.querySelector('.msg-bubble-image');
    if (im) markImageLoaded(im);
  }

  /* ── Polls (lib/polls.js, migration 065) ────────────────────────────────────────────
     One renderer for both the server-rendered page (a .msg-poll placeholder with the state
     in data-poll) and messages the client builds. Votes go to /messages/poll/:id/vote; the
     answer, and 'poll:update' over SSE for everyone else, carry the new state. */
  const POLL_MAX_OPTIONS = 10;
  const pollModal = document.getElementById('pollModal');
  const pollOptionsEl = document.getElementById('pollOptions');
  function pollT(ru, en) { return LANG === 'ru' ? ru : en; }

  function pollOptionRow(value) {
    const row = document.createElement('div');
    row.className = 'msg-poll-option-edit';
    row.innerHTML = '<input type="radio" name="pollCorrect" title="' + escAttr(pollT('Правильный ответ', 'Right answer')) + '" hidden />' +
      '<input type="text" class="msg-poll-input" maxlength="100" placeholder="' + escAttr(pollT('Вариант ответа', 'Add an option')) + '" />' +
      '<button type="button" class="msg-poll-option-remove" aria-label="' + escAttr(pollT('Убрать', 'Remove')) + '">&times;</button>';
    row.querySelector('input[type="text"]').value = value || '';
    return row;
  }
  function pollRows() { return Array.from(pollOptionsEl.querySelectorAll('.msg-poll-option-edit')); }
  function pollValues() { return pollRows().map(function(r) { return r.querySelector('input[type="text"]').value.trim(); }); }
  // The last row is always an empty one to type into, up to the limit.
  function settlePollRows() {
    const rows = pollRows();
    const filled = rows.filter(function(r) { return r.querySelector('input[type="text"]').value.trim(); });
    const empties = rows.filter(function(r) { return !r.querySelector('input[type="text"]').value.trim(); });
    if (rows.length < POLL_MAX_OPTIONS && !empties.length) pollOptionsEl.appendChild(pollOptionRow(''));
    for (let i = 1; i < empties.length; i++) if (empties[i] !== document.activeElement.closest('.msg-poll-option-edit')) empties[i].remove();
    const left = POLL_MAX_OPTIONS - filled.length;
    document.getElementById('pollOptionsHint').textContent = left > 0
      ? pollT('Можно добавить ещё ' + left + ' ' + plural(left, ['вариант', 'варианта', 'вариантов']), 'You can add ' + left + ' more ' + (left === 1 ? 'option' : 'options'))
      : pollT('Больше вариантов добавить нельзя', 'No more options can be added');
    const quiz = document.getElementById('pollQuiz').checked;
    pollRows().forEach(function(r) { r.querySelector('input[type="radio"]').hidden = !quiz; });
  }
  function openPollModal() {
    if (!pollModal) return;
    document.getElementById('pollQuestion').value = '';
    pollOptionsEl.innerHTML = '';
    pollOptionsEl.appendChild(pollOptionRow(''));
    pollOptionsEl.appendChild(pollOptionRow(''));
    ['pollMultiple', 'pollShuffle', 'pollQuiz'].forEach(function(id) { document.getElementById(id).checked = false; });
    document.getElementById('pollAnonymous').checked = true;
    document.getElementById('pollRevote').checked = true;
    document.getElementById('pollDuration').value = '';
    document.getElementById('pollError').hidden = true;
    settlePollRows();
    pollModal.classList.add('show');
    setTimeout(function() { document.getElementById('pollQuestion').focus(); }, 50);
  }
  function closePollModal() { if (pollModal) pollModal.classList.remove('show'); }
  if (pollModal) {
    document.getElementById('pollModalClose').addEventListener('click', closePollModal);
    document.getElementById('pollCancel').addEventListener('click', closePollModal);
    pollModal.addEventListener('click', function(e) { if (e.target === pollModal) closePollModal(); });
    pollOptionsEl.addEventListener('input', settlePollRows);
    pollOptionsEl.addEventListener('click', function(e) {
      const rm = e.target.closest('.msg-poll-option-remove');
      if (rm) { rm.closest('.msg-poll-option-edit').remove(); settlePollRows(); }
    });
    pollOptionsEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.target.matches('input[type="text"]')) {
        e.preventDefault();
        settlePollRows();
        const inputs = pollRows().map(function(r) { return r.querySelector('input[type="text"]'); });
        const i = inputs.indexOf(e.target);
        if (inputs[i + 1]) inputs[i + 1].focus();
      }
    });
    document.getElementById('pollQuiz').addEventListener('change', function() {
      const quiz = this.checked;
      if (quiz) { document.getElementById('pollMultiple').checked = false; document.getElementById('pollRevote').checked = false; }
      settlePollRows();
    });
    document.getElementById('pollMultiple').addEventListener('change', function() { if (this.checked) { document.getElementById('pollQuiz').checked = false; settlePollRows(); } });
    document.getElementById('pollCreate').addEventListener('click', function() {
      const btn = this;
      const rows = pollRows().filter(function(r) { return r.querySelector('input[type="text"]').value.trim(); });
      const options = rows.map(function(r) { return r.querySelector('input[type="text"]').value.trim(); });
      const quiz = document.getElementById('pollQuiz').checked;
      const correctIndex = quiz ? rows.findIndex(function(r) { return r.querySelector('input[type="radio"]').checked; }) : null;
      const body = {
        question: document.getElementById('pollQuestion').value.trim(),
        options: options,
        anonymous: document.getElementById('pollAnonymous').checked,
        multiple: document.getElementById('pollMultiple').checked,
        revote: document.getElementById('pollRevote').checked,
        shuffle: document.getElementById('pollShuffle').checked,
        quiz: quiz,
        correctIndex: correctIndex,
        durationMinutes: document.getElementById('pollDuration').value || null,
      };
      const errEl = document.getElementById('pollError');
      const say = function(t) { errEl.textContent = t; errEl.hidden = false; };
      if (!body.question) return say(pollT('Напишите вопрос.', 'Write the question.'));
      if (options.length < 2) return say(pollT('Нужно хотя бы два варианта.', 'At least two options are needed.'));
      if (quiz && correctIndex < 0) return say(pollT('Отметьте правильный ответ.', 'Mark the right answer.'));
      btn.disabled = true;
      fetch('/messages/' + CONV_ID + '/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
        .then(function(x) {
          btn.disabled = false;
          if (!x.ok) return say(x.d && x.d.error && x.d.error.length > 20 ? x.d.error : pollT('Не получилось создать опрос.', 'Could not create the poll.'));
          closePollModal();
          if (x.d.message && !document.querySelector('[data-msg-id="' + x.d.message.id + '"]')) { appendMessage(x.d.message); lastMsgId = Math.max(lastMsgId, x.d.message.id); }
          refreshConvList();
        })
        .catch(function() { btn.disabled = false; say(pollT('Нет связи.', 'No connection.')); });
    });
  }

  // The bubble's poll. `el` is the .msg-poll placeholder; `p` the state from the server.
  function pollHTML(p) {
    const closed = p.closed;
    const showResults = p.voted || closed;
    const kind = (p.quiz ? pollT('Викторина', 'Quiz') : p.anonymous ? pollT('Анонимный опрос', 'Anonymous poll') : pollT('Открытый опрос', 'Public poll')) +
      (closed ? ' · ' + pollT('завершён', 'closed') : '');
    let html = '<div class="msg-poll-question">' + esc(p.question) + '</div><div class="msg-poll-kind">' + esc(kind) + '</div>';
    if (showResults) {
      /* Telegram's results: the percentage, the option, its votes; under it a bar, and on the
         option this viewer chose a filled dot with a check. In a quiz the right answer's bar is
         green and a wrong choice's bar red, the dot saying which with a check or a cross. */
      p.options.forEach(function(o) {
        let tone = '';
        if (p.quiz && p.correct != null) tone = o.id === p.correct ? ' right' : (o.mine ? ' wrong' : '');
        const dot = o.mine ? '<span class="msg-poll-dot' + tone + '">' + (tone === ' wrong' ? '✕' : '') + '</span>' : '<span class="msg-poll-dot none"></span>';
        html += '<div class="msg-poll-result' + (o.mine ? ' mine' : '') + tone + '" data-option="' + o.id + '">' +
          '<div class="msg-poll-result-head"><span class="msg-poll-percent">' + o.percent + '%</span><span class="msg-poll-result-text">' + esc(o.text) + '</span><span class="msg-poll-count">' + (o.votes || '') + '</span></div>' +
          '<div class="msg-poll-bar-row">' + dot + '<div class="msg-poll-bar"><i style="width:' + o.percent + '%"></i></div></div>' +
          (!p.anonymous && o.votes ? '<div class="msg-poll-voters" data-voters="' + o.id + '"></div>' : '') +
          '</div>';
      });
    } else {
      p.options.forEach(function(o) {
        html += '<button type="button" class="msg-poll-option" data-option="' + o.id + '"><span class="msg-poll-box' + (p.multiple ? ' square' : '') + '"></span><span>' + esc(o.text) + '</span></button>';
      });
      if (p.multiple) html += '<button type="button" class="msg-poll-vote-btn" data-poll-vote disabled>' + esc(pollT('Голосовать', 'Vote')) + '</button>';
    }
    const n = p.voters;
    let meta = closed ? pollT('Опрос завершён', 'Final results') + ' · ' : '';
    meta += n ? n + ' ' + plural(n, pollT(['голос', 'голоса', 'голосов'], ['vote', 'votes', 'votes'])) : pollT('Пока нет голосов', 'No votes yet');
    html += '<div class="msg-poll-meta"><span>' + esc(meta) + '</span>';
    if (p.canRetract) html += '<button type="button" data-poll-retract>' + esc(pollT('Отозвать голос', 'Retract vote')) + '</button>';
    if (p.canClose) html += '<button type="button" data-poll-close>' + esc(pollT('Завершить', 'Close poll')) + '</button>';
    if (p.closesAt && !closed) html += '<span>' + esc(pollT('до ', 'until ')) + '<time datetime="' + escAttr(p.closesAt) + '" data-local="daytime" data-lang="' + LANG + '">' + esc(new Date(p.closesAt).toLocaleString(TIME_LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</time></span>';
    html += '</div>';
    return html;
  }
  function renderPoll(el, p) {
    if (!el || !p) return;
    el.__poll = p;
    el.dataset.pollId = p.id;
    el.innerHTML = pollHTML(p);
    typesetMath(el);   /* $…$ in a question or an option, as in any message (the page's first pass covers the initial render) */
    if (!p.anonymous && (p.voted || p.closed) && p.voters) loadPollVoters(el, p);
  }
  function loadPollVoters(el, p) {
    fetch('/messages/poll/' + p.id + '/voters', { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d || el.__poll !== p) return;
        const by = {};
        (d.voters || []).forEach(function(v) { (by[v.option_id] = by[v.option_id] || []).push(v.username); });
        el.querySelectorAll('[data-voters]').forEach(function(box) {
          const names = by[box.dataset.voters] || [];
          box.innerHTML = names.map(function(u) { return '<a href="/user/' + encodeURIComponent(u) + '">' + esc(u) + '</a>'; }).join(', ');
        });
      }).catch(function() {});
  }
  function pollFromPlaceholder(el) {
    if (el.__poll) return;
    try { renderPoll(el, JSON.parse(el.dataset.poll)); } catch (e) {}
  }
  document.querySelectorAll('.msg-poll[data-poll]').forEach(pollFromPlaceholder);

  function pollRequest(el, path, body) {
    const p = el.__poll;
    if (!p) return;
    fetch('/messages/poll/' + p.id + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
      .then(function(x) {
        if (x.ok && x.d.poll) { renderPoll(el, x.d.poll); return; }
        const err = x.d && x.d.error;
        if (err === 'closed') { p.closed = true; renderPoll(el, p); }
        else if (err && err.length > 20) alert(err);
      })
      .catch(function() {});
  }
  if (chatEl) {
    chatEl.addEventListener('click', function(e) {
      const el = e.target.closest('.msg-poll');
      if (!el || !el.__poll) return;
      const p = el.__poll;
      const opt = e.target.closest('.msg-poll-option');
      if (opt) {
        e.preventDefault();
        if (p.multiple) {
          opt.classList.toggle('on');
          const any = el.querySelector('.msg-poll-option.on');
          const btn = el.querySelector('[data-poll-vote]');
          if (btn) btn.disabled = !any;
        } else {
          pollRequest(el, '/vote', { optionIds: [parseInt(opt.dataset.option)] });
        }
        return;
      }
      if (e.target.closest('[data-poll-vote]')) {
        const ids = Array.from(el.querySelectorAll('.msg-poll-option.on')).map(function(o) { return parseInt(o.dataset.option); });
        if (ids.length) pollRequest(el, '/vote', { optionIds: ids });
        return;
      }
      if (e.target.closest('[data-poll-retract]')) { pollRequest(el, '/retract'); return; }
      if (e.target.closest('[data-poll-close]')) {
        if (confirm(pollT('Завершить опрос? Голосовать больше нельзя будет.', 'Close the poll? Nobody will be able to vote after that.'))) pollRequest(el, '/close');
      }
    });
  }
  // Counts from someone else's vote: keep what this viewer chose, the rest is the server's.
  function applyPollUpdate(d) {
    const row = document.querySelector('[data-msg-id="' + d.messageId + '"]');
    const el = row && row.querySelector('.msg-poll');
    if (!el || !el.__poll || !d.poll) return;
    const old = el.__poll;
    const next = Object.assign({}, old, d.poll, { mine: old.mine, voted: old.voted, canRetract: old.canRetract && !d.poll.closed, canClose: old.canClose && !d.poll.closed });
    next.options = d.poll.options.map(function(o) { return Object.assign({}, o, { mine: (old.mine || []).indexOf(o.id) !== -1 }); });
    if (old.options.length === next.options.length) {
      // the server's order is this viewer's own shuffle; a broadcast has the creator's order
      const pos = {}; old.options.forEach(function(o, i) { pos[o.id] = i; });
      next.options.sort(function(a, b) { return (pos[a.id] || 0) - (pos[b.id] || 0); });
    }
    if (next.quiz && !next.voted && !next.closed) next.correct = null;
    // A multiple-answer poll being filled in keeps its ticks.
    const ticked = Array.from(el.querySelectorAll('.msg-poll-option.on')).map(function(o) { return o.dataset.option; });
    renderPoll(el, next);
    ticked.forEach(function(id) { const o = el.querySelector('.msg-poll-option[data-option="' + id + '"]'); if (o) o.classList.add('on'); });
    const btn = el.querySelector('[data-poll-vote]'); if (btn && ticked.length) btn.disabled = false;
  }

  /* ── Reactions ─────────────────────────────────────────────────────
     One vocabulary for the site (js/reactions.js): the six Unicode emoji and the
     community's :shortcode: set, drawn in img/emoji. If that script failed to load (RX is
     null), stored reactions still show as text and messages still send; only the picker
     stays empty. */
  function reactionGlyph(value) {
    return RX ? RX.glyphHTML(value, REACTION_URLS, LANG) : esc(value);
  }

  // The picker ships empty and is filled the first time it opens. Premium reactions (bought with
  // quanta in «Последняя задача») follow a second rule and stay locked until this member owns
  // them (js/apps/launcher.js knows which).
  function fillReactionPicker(picker) {
    if (!picker || !RX || picker.childElementCount) return;
    var premium = window.SSApps ? window.SSApps.premium : null;
    var ids = premium ? premium.pickerIds() : RX.pickerIds();
    var html = '';
    ids.forEach(function(id, i) {
      if (i === RX.STANDARD.length) html += '<span class="msg-reaction-sep"></span>';
      if (RX.isPremium(id) && i > 0 && !RX.isPremium(ids[i - 1])) html += '<span class="msg-reaction-sep"></span>';
      var locked = !!(premium && premium.isLocked(id));
      var title = locked ? premium.lockedTitle(id, LANG) : RX.reactionTitle(id, LANG);
      html += '<span class="msg-reaction-pick' + (locked ? ' is-locked' : '') + '" data-emoji="' + escAttr(id) + '"' +
        (title ? ' title="' + escAttr(title) + '"' : '') + '>' + reactionGlyph(id) + '</span>';
    });
    picker.innerHTML = html;
  }

  function renderReactionAddHTML(msgId) {
    // A bubble that is not saved yet has nothing to react to; the next poll replaces it.
    if (!msgId) return '';
    var html = '<div class="msg-reaction-add" data-msg-id="' + msgId + '">';
    html += '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
    html += '<div class="msg-reaction-picker"></div></div>';
    return html;
  }

  function renderReactionsHTML(msgId, reactions) {
    if (!reactions || !reactions.length) return '';
    var html = '<div class="msg-reactions" data-msg-id="' + msgId + '">';
    reactions.forEach(function(r) {
      html += '<span class="msg-reaction' + (r.me ? ' me' : '') + '" data-emoji="' + escAttr(r.emoji) + '" data-msg-id="' + msgId + '">' + reactionGlyph(r.emoji) + '<span class="msg-reaction-count">' + r.count + '</span></span>';
    });
    html += '</div>';
    return html;
  }

  function updateReactionsUI(msgId, reactions) {
    var row = chatEl.querySelector('[data-msg-id="' + msgId + '"]');
    if (!row) return;
    var existing = row.querySelector('.msg-reactions[data-msg-id="' + msgId + '"]');
    if (reactions && reactions.length > 0) {
      var tmp = document.createElement('div');
      tmp.innerHTML = renderReactionsHTML(msgId, reactions);
      var newEl = tmp.firstChild;
      if (existing) {
        existing.replaceWith(newEl);
      } else {
        var bubble = row.querySelector('.msg-bubble');
        if (bubble) bubble.insertAdjacentElement('afterend', newEl);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  function toggleReaction(msgId, emoji) {
    fetch('/messages/' + msgId + '/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: emoji }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.reactions) updateReactionsUI(msgId, data.reactions);
      else if (data.error === 'locked' && window.SSApps) window.SSApps.open({ tab: 'shop', rx: emoji });
    })
    .catch(function(err) { console.error('Reaction error:', err); });
  }

  // Apply an edit/delete to an existing bubble (shared by SSE + catch-up poll).
  function applyMessageUpdate(u) {
    const row = document.querySelector('[data-msg-id="' + u.id + '"]');
    if (!row) return;
    const bubble = row.querySelector('.msg-bubble');
    if (!bubble) return;
    if (u.deleted_at) {
      row.style.display = 'none';
      return;
    }
    if (u.edited_at) rebuildBubbleText(bubble, u.id, u.content);
  }

  // A video finished converting (or could not be): the server sends the message as it now is,
  // and the row is drawn again from it, keeping the reactions people already left.
  function applyAttachmentUpdate(m) {
    const row = document.querySelector('[data-msg-id="' + m.id + '"]');
    if (!row) return;
    const fresh = buildMessageRow(Object.assign({}, m, { reactions: [] }));
    const reactions = row.querySelector('.msg-reactions');
    if (reactions) {
      const bubble = fresh.querySelector('.msg-bubble');
      if (bubble) bubble.insertAdjacentElement('afterend', reactions);
    }
    if (row.dataset.pendingKey) fresh.dataset.pendingKey = row.dataset.pendingKey;
    row.replaceWith(fresh);
    typesetMath(fresh);
    markLoadedImages(fresh);
  }

  // Mark the (visible) active conversation read, throttled — tells the server so
  // the other side's receipts advance. Called when a new message arrives.
  let lastReadSent = 0;
  function markReadThrottled() {
    if (!CONV_ID || document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastReadSent < 1000) return;
    lastReadSent = now;
    fetch('/messages/' + CONV_ID + '/read', { method: 'POST', headers: { 'Accept': 'application/json' } }).catch(function() {});
  }

  // Catch-up fetch: pulls anything missed while disconnected (on SSE connect /
  // reconnect / health-watchdog). Not a polling loop.
  function pollMessages() {
    if (!CONV_ID) return;
    const url = '/messages/' + CONV_ID + '/poll?after=' + lastMsgId + '&since=' + encodeURIComponent(lastPollTime);
    lastPollTime = new Date().toISOString();
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.messages && data.messages.length > 0) {
          // Not the ones marked unsent: those are the messages that never arrived,
          // and removing them would hide the only evidence the person has.
          chatEl.querySelectorAll('[data-msg-id="0"]:not(.msg-unsent)').forEach(function(el) { el.remove(); });
          data.messages.forEach(function(m) {
            if (document.querySelector('[data-msg-id="' + m.id + '"]')) return;
            appendMessage(m);
            lastMsgId = Math.max(lastMsgId, m.id);
          });
          refreshConvList();
        }
        if (data.updates && data.updates.length > 0) data.updates.forEach(applyMessageUpdate);
        if (data.reactionUpdates && data.reactionUpdates.length > 0) {
          data.reactionUpdates.forEach(function(ru) { updateReactionsUI(ru.message_id, ru.reactions); });
        }
        if (typeof data.readCutoff !== 'undefined' && data.readCutoff !== readCutoff) {
          readCutoff = data.readCutoff;
          updateAllReceipts();
        }
        if (data.hasOwnProperty('pinnedMessage')) applyPinned(data.pinnedMessage);
        if (data.hasOwnProperty('typing')) renderTyping(data.typing);
      })
      .catch(function() {});
  }

  // ── Live updates via Server-Sent Events (replaces the polling loop) ──
  let sse = null;
  let lastSseEventAt = Date.now();

  function handleSseNewMessage(d) {
    if (d.conversationId === CONV_ID && d.message) {
      const m = d.message;
      if (!document.querySelector('[data-msg-id="' + m.id + '"]')) {
        appendMessage(m);
        lastMsgId = Math.max(lastMsgId, m.id);
        markReadThrottled();
      }
    }
    refreshConvList(); // update sidebar order/preview/unread for any conversation
  }

  function connectSSE() {
    if (typeof EventSource === 'undefined') { startPollFallback(); return; }
    try { sse = new EventSource('/messages/stream'); }
    catch (e) { startPollFallback(); return; }

    sse.addEventListener('ready', function() {
      lastSseEventAt = Date.now();
      stopPollFallback();
      if (CONV_ID) pollMessages(); // catch up on anything missed before connect
      refreshConvList();
      // The stream being up is the most reliable evidence the connection is back —
      // more so than the `online` event, which fires for a captive portal too.
      if (CONV_ID && typeof flushFailed === 'function') flushFailed();
    });
    sse.addEventListener('ping', function() { lastSseEventAt = Date.now(); });

    sse.addEventListener('msg:new', function(e) { lastSseEventAt = Date.now(); handleSseNewMessage(JSON.parse(e.data)); });
    sse.addEventListener('msg:edit', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID) applyMessageUpdate({ id: d.id, content: d.content, edited_at: d.edited_at });
    });
    sse.addEventListener('msg:delete', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID) applyMessageUpdate({ id: d.id, deleted_at: true });
      refreshConvList();
    });
    sse.addEventListener('msg:update', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID) applyAttachmentUpdate(d);
    });
    sse.addEventListener('poll:update', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID) applyPollUpdate(d);
    });
    sse.addEventListener('msg:react', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID) updateReactionsUI(d.messageId, d.reactions);
    });
    sse.addEventListener('typing', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID) renderTyping(d.names);
    });
    sse.addEventListener('read', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID && d.readCutoff !== readCutoff) {
        readCutoff = d.readCutoff;
        updateAllReceipts();
      }
    });
    sse.addEventListener('pin', function(e) {
      lastSseEventAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.conversationId === CONV_ID) applyPinned(d.pinnedMessage);
    });

    // EventSource auto-reconnects on error; 'ready' fires again → catch-up runs.
    sse.addEventListener('error', function() { /* browser retries automatically */ });
  }

  // Health watchdog: if no SSE event (incl. 20s pings) arrives for a while, the
  // stream is likely dead/buffered — do a catch-up fetch as a fallback.
  function startPollFallback() {
    if (pollTimer) return;
    pollTimer = setInterval(function() { pollMessages(); refreshConvList(); }, 4000);
  }
  function stopPollFallback() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  setInterval(function() {
    if (Date.now() - lastSseEventAt > 45000) { pollMessages(); refreshConvList(); }
  }, 15000);

  connectSSE();

  // ── Older-message history (pagination, scroll up) ───────────────────
  const historyLoader = document.getElementById('historyLoader');

  function prependHistory(msgs) {
    if (!chatEl || !msgs.length) return;
    // Anchor to the bottom so prepended content doesn't move the viewport.
    const distFromBottom = chatEl.scrollHeight - chatEl.scrollTop;

    const frag = document.createDocumentFragment();
    const newBubbles = [];
    let batchLastKey = null;
    msgs.forEach(function(m) {
      if (m.deleted_at) return;
      const key = clientDayKey(m.created_at);
      if (key !== batchLastKey) {
        frag.appendChild(makeDateSep(m.created_at));
        batchLastKey = key;
      }
      const row = buildMessageRow(m);
      frag.appendChild(row);
      newBubbles.push(row.querySelector('.msg-bubble'));
    });

    // If the batch's last day equals the first existing separator's day, that
    // separator is now a duplicate.
    const firstExistingSep = chatEl.querySelector('.msg-date-sep');
    if (firstExistingSep && batchLastKey && firstExistingSep.dataset.date === batchLastKey) {
      firstExistingSep.remove();
    }

    const anchor = historyLoader ? historyLoader.nextSibling : chatEl.firstChild;
    chatEl.insertBefore(frag, anchor);
    chatEl.scrollTop = chatEl.scrollHeight - distFromBottom;
    newBubbles.forEach(function(b) { if (b) typesetMath(b); });
    markLoadedImages(chatEl);
  }

  function loadOlder() {
    if (loadingHistory || !hasMoreHistory || !CONV_ID || !oldestMsgId) return Promise.resolve();
    loadingHistory = true;
    if (historyLoader) historyLoader.classList.add('show');
    return fetch('/messages/' + CONV_ID + '/history?before=' + oldestMsgId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (historyLoader) historyLoader.classList.remove('show');
        const msgs = (data && data.messages) || [];
        if (msgs.length) {
          prependHistory(msgs);
          oldestMsgId = parseInt(msgs[0].id) || oldestMsgId;
        }
        hasMoreHistory = !!(data && data.hasMore);
        /* A page that shows nothing (all deleted, or hidden for this member) leaves the
           scroll where it was, so no scroll event would ask for the next one: ask now. */
        if (hasMoreHistory && !msgs.some(function(m) { return !m.deleted_at; })) return loadOlder.__again = true;
      })
      .catch(function() { if (historyLoader) historyLoader.classList.remove('show'); })
      .then(function() {
        loadingHistory = false;
        if (loadOlder.__again) { loadOlder.__again = false; return loadOlder(); }
      });
  }

  const scrollDownBtn = document.getElementById('scrollDownBtn');
  function updateScrollDown() {
    if (!scrollDownBtn || !chatEl) return;
    scrollDownBtn.hidden = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 300;
  }
  if (scrollDownBtn && chatEl) {
    scrollDownBtn.addEventListener('click', function() { chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' }); });
    setTimeout(updateScrollDown, 800);
  }
  if (chatEl) {
    chatEl.addEventListener('scroll', function() {
      if (chatEl.scrollTop < 80 && hasMoreHistory && !loadingHistory) loadOlder();
      updateScrollDown();
    });
  }

  // Jump to a message, loading older pages until it's in the DOM (search/permalink).
  function jumpToMessageDeep(targetId, attempt) {
    targetId = parseInt(targetId);
    if (!targetId || !chatEl) return;
    attempt = attempt || 0;
    var el = chatEl.querySelector('.msg-bubble-row[data-msg-id="' + targetId + '"]');
    if (el) { jumpToMessage(targetId); return; }
    if (!hasMoreHistory || attempt > 40) return; // give up
    loadOlder().then(function() { jumpToMessageDeep(targetId, attempt + 1); });
  }

  // ── Mute toggle ─────────────────────────────────────────────────────
  var muteToggle = document.getElementById('muteToggle');
  if (muteToggle) {
    muteToggle.addEventListener('click', function() {
      fetch('/messages/' + CONV_ID + '/mute', { method: 'POST', headers: { 'Accept': 'application/json' } })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.error) { alert(d.error); return; }
          var on = document.getElementById('muteIconOn');
          var off = document.getElementById('muteIconOff');
          if (on) on.style.display = d.muted ? 'none' : '';
          if (off) off.style.display = d.muted ? '' : 'none';
          muteToggle.classList.toggle('active', d.muted);
        })
        .catch(function() {});
    });
  }

  // ── In-conversation search ──────────────────────────────────────────
  var searchToggle = document.getElementById('searchToggle');
  var msgSearchBar = document.getElementById('msgSearchBar');
  var msgSearchInput = document.getElementById('msgSearchInput');
  var msgSearchClose = document.getElementById('msgSearchClose');
  var msgSearchList = document.getElementById('msgSearchList');
  var msgSearchCount = document.getElementById('msgSearchCount');
  var searchTimer2 = null;

  function closeSearch() {
    if (msgSearchBar) msgSearchBar.classList.remove('show');
    if (msgSearchList) { msgSearchList.style.display = 'none'; msgSearchList.innerHTML = ''; }
    if (msgSearchCount) msgSearchCount.textContent = '';
    if (searchToggle) searchToggle.classList.remove('active');
  }
  if (searchToggle) {
    searchToggle.addEventListener('click', function() {
      if (!msgSearchBar) return;
      var show = !msgSearchBar.classList.contains('show');
      msgSearchBar.classList.toggle('show', show);
      searchToggle.classList.toggle('active', show);
      if (show && msgSearchInput) msgSearchInput.focus();
      else closeSearch();
    });
  }
  if (msgSearchClose) msgSearchClose.addEventListener('click', closeSearch);
  if (msgSearchInput) {
    msgSearchInput.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeSearch(); });
    msgSearchInput.addEventListener('input', function() {
      clearTimeout(searchTimer2);
      var q = this.value.trim();
      if (q.length < 2) { if (msgSearchList) msgSearchList.style.display = 'none'; if (msgSearchCount) msgSearchCount.textContent = ''; return; }
      searchTimer2 = setTimeout(function() {
        fetch('/messages/' + CONV_ID + '/search?q=' + encodeURIComponent(q))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var results = (data && data.results) || [];
            if (msgSearchCount) msgSearchCount.textContent = results.length + (LANG === 'ru' ? ' найдено' : ' found');
            if (!msgSearchList) return;
            msgSearchList.innerHTML = '';
            results.forEach(function(m) {
              var el = document.createElement('div');
              el.className = 'msg-search-result';
              el.innerHTML = '<div>' + esc((m.content || '').substring(0, 120)) + '</div>' +
                '<div class="msg-search-result-meta">' + esc(m.sender_username || '') + ' · ' + fmtTime(m.created_at) + '</div>';
              el.addEventListener('click', function() {
                closeSearch();
                jumpToMessageDeep(m.id);
              });
              msgSearchList.appendChild(el);
            });
            msgSearchList.style.display = results.length ? 'block' : 'none';
          })
          .catch(function() {});
      }, 300);
    });
  }

  // ── Group management ────────────────────────────────────────────────
  function groupAction(path, body) {
    return fetch('/messages/' + CONV_ID + '/group/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function(r) { return r.json(); });
  }
  var groupRenameBtn = document.getElementById('groupRenameBtn');
  var groupAddBtn = document.getElementById('groupAddBtn');
  var groupLeaveBtn = document.getElementById('groupLeaveBtn');
  var membersPanelEl = document.getElementById('membersPanel');

  if (groupRenameBtn) {
    groupRenameBtn.addEventListener('click', function() {
      var title = prompt(LANG === 'ru' ? 'Новое название группы:' : 'New group name:');
      if (!title || !title.trim()) return;
      groupAction('rename', { title: title.trim() }).then(function(d) {
        if (d.error) { alert(d.error); return; }
        window.location.reload();
      });
    });
  }
  if (groupAddBtn) {
    groupAddBtn.addEventListener('click', function() {
      // Reuse the forward user-search modal pattern via a simple prompt-driven search.
      var q = prompt(LANG === 'ru' ? 'Имя пользователя для добавления:' : 'Username to add:');
      if (!q || !q.trim()) return;
      fetch('/messages/search-users?q=' + encodeURIComponent(q.trim()))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var users = (data && data.users) || [];
          if (!users.length) { alert(LANG === 'ru' ? 'Пользователь не найден' : 'No user found'); return; }
          var u = users[0];
          if (!confirm((LANG === 'ru' ? 'Добавить ' : 'Add ') + u.username + '?')) return;
          groupAction('add', { userIds: [u.id] }).then(function(d) {
            if (d.error) { alert(d.error); return; }
            window.location.reload();
          });
        });
    });
  }
  if (groupLeaveBtn) {
    groupLeaveBtn.addEventListener('click', function() {
      if (!confirm(LANG === 'ru' ? 'Выйти из группы?' : 'Leave this group?')) return;
      groupAction('leave', {}).then(function(d) {
        if (d.error) { alert(d.error); return; }
        window.location.href = '/' + LANG + '/messages';
      });
    });
  }
  if (membersPanelEl) {
    membersPanelEl.addEventListener('click', function(e) {
      var btn = e.target.closest('.msg-member-act');
      if (!btn) return;
      var act = btn.dataset.act;
      var uid = parseInt(btn.dataset.user);
      if (act === 'remove') {
        if (!confirm(LANG === 'ru' ? 'Удалить участника?' : 'Remove this member?')) return;
        groupAction('remove', { userId: uid }).then(function(d) {
          if (d.error) { alert(d.error); return; }
          window.location.reload();
        });
      } else if (act === 'role') {
        groupAction('role', { userId: uid, role: btn.dataset.newrole }).then(function(d) {
          if (d.error) { alert(d.error); return; }
          window.location.reload();
        });
      }
    });
  }

  // ── Pinned message bar + pin toggle ─────────────────────────────────
  const pinnedBar = document.getElementById('pinnedBar');
  const pinnedBarText = document.getElementById('pinnedBarText');
  const pinnedUnpin = document.getElementById('pinnedUnpin');

  function applyPinned(pin) {
    if (!pinnedBar) return;
    if (pin && pin.id) {
      pinnedBar.dataset.target = pin.id;
      if (pinnedBarText) pinnedBarText.textContent = (pin.sender ? pin.sender + ': ' : '') + (pin.preview || '');
      pinnedBar.classList.add('show');
    } else {
      pinnedBar.dataset.target = '';
      pinnedBar.classList.remove('show');
    }
  }

  function togglePin(msgId) {
    fetch('/messages/' + msgId + '/pin', { method: 'POST', headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { alert(data.error); return; }
        const row = document.querySelector('.msg-bubble-row[data-msg-id="' + msgId + '"]');
        if (row) row.dataset.pinned = data.pinned ? '1' : '';
        applyPinned(data.pinnedMessage);
      })
      .catch(function() {});
  }

  if (pinnedBar) {
    pinnedBar.addEventListener('click', function(e) {
      if (e.target.closest('#pinnedUnpin')) return;
      const t = parseInt(pinnedBar.dataset.target);
      if (t) jumpToMessage(t);
    });
  }
  if (pinnedUnpin) {
    pinnedUnpin.addEventListener('click', function(e) {
      e.stopPropagation();
      const t = parseInt(pinnedBar.dataset.target);
      if (t) togglePin(t);
    });
  }

  // ── Typing indicator ────────────────────────────────────────────────
  const typingBar = document.getElementById('typingBar');
  const typingText = document.getElementById('typingText');
  let lastTypingSent = 0;

  function maybeSendTyping() {
    if (!CONV_ID || editingMsgId) return;
    if (!msgInput || !msgInput.value.trim()) return;
    const now = Date.now();
    if (now - lastTypingSent < 3000) return; // throttle: at most one ping / 3s
    lastTypingSent = now;
    fetch('/messages/' + CONV_ID + '/typing', { method: 'POST', headers: { 'Accept': 'application/json' } }).catch(function() {});
  }

  function renderTyping(names) {
    if (!typingBar || !typingText) return;
    if (!names || !names.length) { typingBar.classList.remove('show'); return; }
    let text;
    if (names.length === 1) {
      text = names[0] + (LANG === 'ru' ? ' печатает' : ' is typing');
    } else if (names.length === 2) {
      text = names[0] + (LANG === 'ru' ? ' и ' : ' and ') + names[1] + (LANG === 'ru' ? ' печатают' : ' are typing');
    } else {
      text = (LANG === 'ru' ? 'Несколько человек печатают' : 'Several people are typing');
    }
    typingText.textContent = text;
    typingBar.classList.add('show');
  }

  // ── Keep the reaction emoji picker inside the viewport ──────────────
  // It is centered over the reaction button, so near a screen edge (mobile) it
  // would overflow. Reposition its left edge to stay within [8, width-8].
  // The grid is three rows tall, and it lives inside the bubble's stacking context, so
  // it must also stay inside the message list: above the top message it would slide
  // under the chat header and the pinned bar.
  let openReactionAdd = null;
  function positionReactionPicker(addBtn) {
    const picker = addBtn.querySelector('.msg-reaction-picker');
    if (!picker) return;
    fillReactionPicker(picker);
    openReactionAdd = addBtn;
    let pw = picker.offsetWidth;
    let ph = picker.offsetHeight;
    if (!pw || !ph) {
      // Hover has not shown it yet: lay it out unseen for the measurement.
      picker.style.visibility = 'hidden';
      picker.style.display = 'grid';
      pw = picker.offsetWidth;
      ph = picker.offsetHeight;
      picker.style.display = '';
      picker.style.visibility = '';
    }
    const r = addBtn.getBoundingClientRect();
    // Horizontal: centered on the button, clamped to the viewport.
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    // Vertical: above the button if it fits inside the list, else below, else on the
    // roomier side.
    const list = chatEl.getBoundingClientRect();
    const minTop = Math.max(8, list.top + 4);
    const maxBottom = Math.min(window.innerHeight - 8, list.bottom - 4);
    let top = r.top - ph - 4;
    if (top < minTop) {
      if (r.bottom + 4 + ph <= maxBottom) top = r.bottom + 4;
      else if (r.top - minTop > maxBottom - r.bottom) top = minTop;
      else top = Math.max(minTop, maxBottom - ph);
    }
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
    picker.style.bottom = 'auto';
    picker.style.transform = 'none';
  }
  // A fixed picker does not follow its message, so scrolling closes it.
  function dismissOpenReactionPicker() {
    if (openReactionAdd && openReactionAdd.matches(':hover')) openReactionAdd.classList.add('is-dismissed');
  }
  if (chatEl) {
    chatEl.addEventListener('mouseover', function(e) {
      const addBtn = e.target.closest('.msg-reaction-add');
      if (!addBtn || addBtn.contains(e.relatedTarget)) return;
      // Coming back from outside re-arms a picker that a pick or a scroll had closed.
      addBtn.classList.remove('is-dismissed');
      positionReactionPicker(addBtn);
    });
    chatEl.addEventListener('touchstart', function(e) {
      const addBtn = e.target.closest('.msg-reaction-add');
      if (!addBtn) return;
      // A tap on the smiley reopens a picker that a pick had closed.
      if (!e.target.closest('.msg-reaction-picker')) addBtn.classList.remove('is-dismissed');
      positionReactionPicker(addBtn);
    }, { passive: true });
    chatEl.addEventListener('wheel', dismissOpenReactionPicker, { passive: true });
    chatEl.addEventListener('touchmove', function(e) {
      if (!e.target.closest('.msg-reaction-picker')) dismissOpenReactionPicker();
    }, { passive: true });
  }

  // ── Live conversation list (sidebar) ────────────────────────────────
  // Fetch the ordered list and re-render the sidebar so that sending or
  // receiving a message floats that conversation to the top automatically.
  const convListEl = document.getElementById('convList');
  let lastConvSig = '';

  // esc() leaves double-quotes intact, so use this for attribute values.
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function buildConvItemHTML(c) {
    const isActive = !!(CONV_ID && c.id === CONV_ID);
    const unread = isActive ? 0 : (c.unread_count || 0);
    let avatar;
    if (c.is_group) {
      avatar = '<div class="msg-conv-avatar-group">' + (c.groupAvatarSvg || '') + '</div>';
    } else {
      const dot = c.isOnline
        ? '<span class="online-dot online-dot--lg" title="' + escAttr(LANG === 'ru' ? 'В сети' : 'Online') + '"></span>'
        : '';
      avatar = '<span class="avatar-presence"><img class="msg-conv-avatar" src="' +
        escAttr(c.displayPicture || '/img/profile_images/Default_placeholder.svg') + '" alt="" />' + dot + '</span>';
    }
    let preview = '';
    if (c.last_message_content || c.last_message_image || c.last_message_file) {
      if (c.last_message_sender_id === USER_ID) preview += (LANG === 'ru' ? 'Вы: ' : 'You: ');
      if (c.last_message_content) {
        const t = c.last_message_content;
        preview += esc(t.substring(0, 60)) + (t.length > 60 ? '...' : '');
      } else if (c.last_message_file) {
        preview += '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:2px;opacity:0.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          esc(c.last_message_file.substring(0, 40));
      } else {
        preview += '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:2px;opacity:0.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
          (LANG === 'ru' ? 'Фото' : 'Photo');
      }
    }
    const badge = unread > 0
      ? '<span class="msg-conv-badge' + (c.muted ? ' muted' : '') + '">' + (unread > 99 ? '99+' : unread) + '</span>'
      : '';
    return '<a href="/' + LANG + '/messages/' + c.id + '" class="msg-conv-item' + (isActive ? ' active' : '') +
      '" data-name="' + escAttr((c.displayName || '').toLowerCase()) + '">' +
      avatar +
      '<div class="msg-conv-info"><div class="msg-conv-name' + (!c.is_group && !c.isSaved && c.displayName ? ' ' + rankClassFor(c.displayName) : '') + '">' + esc(c.displayName || '') + (c.verified ? VERIFIED_HTML : '') + '</div>' +
      '<div class="msg-conv-preview">' + preview + '</div></div>' +
      '<div class="msg-conv-meta"><span class="msg-conv-time" data-iso="' + escAttr(c.last_message_at || '') + '">' + esc(convTimeText(c.last_message_at)) + '</span>' +
      badge + '</div>' +
      '</a>';
  }

  function refreshConvList() {
    if (!convListEl) return;
    fetch('/messages/list-data')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !Array.isArray(data.conversations)) return;
        // Skip DOM churn unless order/preview/unread/time actually changed.
        const sig = data.conversations.map(function(c) {
          const unread = (CONV_ID && c.id === CONV_ID) ? 0 : (c.unread_count || 0);
          return c.id + ':' + (c.last_message_at || '') + ':' + unread + ':' +
            (c.last_message_content || '') + ':' + (c.last_message_image ? 1 : 0) + ':' +
            (c.isOnline ? 1 : 0) + ':' + (c.muted ? 1 : 0);
        }).join('|');
        if (sig === lastConvSig) return;
        lastConvSig = sig;

        // A brand-new conversation with no messages yet isn't returned by the
        // endpoint; keep its (currently active) sidebar entry so it doesn't vanish.
        let activeHTML = '';
        if (CONV_ID && !data.conversations.some(function(c) { return c.id === CONV_ID; })) {
          const activeEl = convListEl.querySelector('.msg-conv-item.active');
          if (activeEl) activeHTML = activeEl.outerHTML;
        }

        const scrollTop = convListEl.scrollTop;
        // The Saved Messages self-chat is rendered as a fixed pinned entry above
        // this list, so exclude it here to avoid a duplicate.
        let html = data.conversations.filter(function(c) { return !c.isSaved; }).map(buildConvItemHTML).join('');
        if (activeHTML) html = activeHTML + html;
        if (!html) {
          html = '<div style="padding: var(--ss-space-7) var(--ss-space-4); text-align: center; color: var(--msg-muted); font-size: var(--ss-fs-14);">' +
            (LANG === 'ru' ? 'Нет сообщений' : 'No conversations yet') + '</div>';
        }
        convListEl.innerHTML = html;
        convListEl.scrollTop = scrollTop;
        localizeSsrTimes();
        // Re-apply the active search filter, if any.
        if (convSearch && convSearch.value) {
          const shown = filterConversations(convSearch.value.trim().toLowerCase());
          if (convSearchChats) convSearchChats.hidden = shown === 0;
        }
      })
      .catch(function() {});
  }

  // The sidebar refreshes on SSE events (new/edit/delete) and on send — no
  // interval needed. A one-shot refresh keeps it correct right after load.
  refreshConvList();

  // Sidebar search, as Telegram's: the chats that match stay at the top under "Chats", and
  // below them, under "Global search results", the people the site knows, each a chat away.
  const convSearch = document.getElementById('convSearch');
  const convSearchClear = document.getElementById('convSearchClear');
  const convSearchChats = document.getElementById('convSearchChats');
  const convSearchResults = document.getElementById('convSearchResults');
  const sidebarEl = document.querySelector('.msg-sidebar');
  let convSearchTimer = null, convSearchSeq = 0;
  function filterConversations(q) {
    let shown = 0;
    document.querySelectorAll('#convList .msg-conv-item').forEach(function(el) {
      const on = !q || (el.dataset.name || '').includes(q);
      el.style.display = on ? '' : 'none';
      if (on) shown++;
    });
    return shown;
  }
  function renderGlobalResults(q, users) {
    const head = '<div class="msg-list-section">' + (LANG === 'ru' ? 'Глобальный поиск' : 'Global search results') + '</div>';
    if (!users.length) {
      convSearchResults.innerHTML = head + '<div class="msg-search-hint">' + esc(LANG === 'ru' ? 'Никого не найдено по запросу «' + q + '»' : 'Nobody found for "' + q + '"') + '</div>';
      return;
    }
    convSearchResults.innerHTML = head + users.map(function(u) {
      return '<form method="POST" action="/messages/new"><input type="hidden" name="recipientId" value="' + Number(u.id) + '" />' +
        '<button type="submit" class="msg-search-user">' +
        '<img src="' + escAttr(u.profile_picture || '/img/profile_images/Default_placeholder.svg') + '" alt="" />' +
        '<span><span class="msg-search-user-name">' + esc(u.username) + '</span>' +
        (u.full_name ? '<br><span class="msg-search-user-full">' + esc(u.full_name) + '</span>' : '') + '</span></button></form>';
    }).join('');
  }
  function runSidebarSearch() {
    const q = convSearch.value.trim().toLowerCase();
    const searching = q.length > 0;
    if (sidebarEl) sidebarEl.classList.toggle('is-searching', searching);
    if (convSearchClear) convSearchClear.hidden = !searching;
    const shown = filterConversations(q);
    if (convSearchChats) convSearchChats.hidden = !searching || shown === 0;   // no label over nothing
    clearTimeout(convSearchTimer);
    if (!searching) { convSearchResults.hidden = true; convSearchResults.innerHTML = ''; return; }
    convSearchResults.hidden = false;
    if (q.length < 2) {
      convSearchResults.innerHTML = '<div class="msg-list-section">' + (LANG === 'ru' ? 'Глобальный поиск' : 'Global search results') + '</div><div class="msg-search-hint">' + (LANG === 'ru' ? 'Введите хотя бы две буквы' : 'Type at least two letters') + '</div>';
      return;
    }
    const seq = ++convSearchSeq;
    convSearchTimer = setTimeout(function() {
      fetch('/messages/search-users?q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } })
        .then(function(r) { return r.json(); })
        .then(function(data) { if (seq === convSearchSeq) renderGlobalResults(q, (data && data.users) || []); })
        .catch(function() {});
    }, 250);
  }
  if (convSearch) {
    convSearch.addEventListener('input', runSidebarSearch);
    convSearch.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { convSearch.value = ''; runSidebarSearch(); }
    });
    if (convSearchClear) convSearchClear.addEventListener('click', function() { convSearch.value = ''; runSidebarSearch(); convSearch.focus(); });
  }

  // New message modal
  const newMsgBtn = document.getElementById('newMsgBtn');
  const modal = document.getElementById('newMsgModal');
  const closeBtn = document.getElementById('closeModal');
  const userSearch = document.getElementById('userSearch');
  const userResults = document.getElementById('userResults');

  if (newMsgBtn) {
    newMsgBtn.addEventListener('click', function() {
      modal.classList.add('show');
      userSearch.focus();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      modal.classList.remove('show');
    });
  }

  modal.addEventListener('click', function(e) {
    if (e.target === modal) modal.classList.remove('show');
  });

  let searchTimer = null;
  if (userSearch) {
    userSearch.addEventListener('input', function() {
      clearTimeout(searchTimer);
      const q = this.value.trim();
      if (q.length < 2) {
        userResults.innerHTML = '';
        return;
      }
      searchTimer = setTimeout(function() {
        fetch('/messages/search-users?q=' + encodeURIComponent(q))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            userResults.innerHTML = '';
            (data.users || []).forEach(function(u) {
              const el = document.createElement('form');
              el.method = 'POST';
              el.action = '/messages/new';
              el.innerHTML =
                '<input type="hidden" name="recipientId" value="' + u.id + '" />' +
                '<button type="submit" class="msg-user-result" style="width:100%;text-align:left;background:none;border:none;">' +
                '<img src="' + esc(u.profile_picture || '/img/profile_images/Default_placeholder.svg') + '" alt="" />' +
                '<div><div class="msg-user-result-name">' + esc(u.username) + '</div>' +
                (u.full_name ? '<div class="msg-user-result-full">' + esc(u.full_name) + '</div>' : '') +
                '</div></button>';
              userResults.appendChild(el);
            });
            if (data.users.length === 0) {
              userResults.innerHTML = '<div style="padding:var(--ss-space-3);text-align:center;color:var(--msg-muted);font-size:var(--ss-fs-13);">No users found</div>';
            }
          });
      }, 300);
    });
  }

  // Group chat
  const groupToggle = document.getElementById('groupToggle');
  const groupForm = document.getElementById('groupForm');
  const groupSearch = document.getElementById('groupSearch');
  const groupResults = document.getElementById('groupResults');
  const selectedUsersEl = document.getElementById('selectedUsers');
  const createGroupBtn = document.getElementById('createGroupBtn');
  const groupTitle = document.getElementById('groupTitle');
  const selectedMembers = [];

  if (groupToggle) {
    groupToggle.addEventListener('click', function() {
      groupForm.classList.toggle('show');
    });
  }

  function updateGroupBtn() {
    createGroupBtn.disabled = selectedMembers.length < 1;
  }

  function renderSelectedUsers() {
    selectedUsersEl.innerHTML = '';
    selectedMembers.forEach(function(u, i) {
      const chip = document.createElement('span');
      chip.className = 'msg-selected-chip';
      chip.innerHTML = esc(u.username) + ' <button class="msg-chip-remove" data-idx="' + i + '">&times;</button>';
      selectedUsersEl.appendChild(chip);
    });
    selectedUsersEl.querySelectorAll('.msg-chip-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        selectedMembers.splice(parseInt(this.dataset.idx), 1);
        renderSelectedUsers();
        updateGroupBtn();
      });
    });
  }

  let groupSearchTimer = null;
  if (groupSearch) {
    groupSearch.addEventListener('input', function() {
      clearTimeout(groupSearchTimer);
      const q = this.value.trim();
      if (q.length < 2) {
        groupResults.innerHTML = '';
        return;
      }
      groupSearchTimer = setTimeout(function() {
        fetch('/messages/search-users?q=' + encodeURIComponent(q))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            groupResults.innerHTML = '';
            (data.users || []).forEach(function(u) {
              if (selectedMembers.some(function(s) { return s.id === u.id; })) return;
              const el = document.createElement('div');
              el.className = 'msg-user-result';
              el.innerHTML =
                '<img src="' + esc(u.profile_picture || '/img/profile_images/Default_placeholder.svg') + '" alt="" />' +
                '<div><div class="msg-user-result-name">' + esc(u.username) + '</div>' +
                (u.full_name ? '<div class="msg-user-result-full">' + esc(u.full_name) + '</div>' : '') +
                '</div>';
              el.addEventListener('click', function() {
                selectedMembers.push(u);
                renderSelectedUsers();
                updateGroupBtn();
                groupSearch.value = '';
                groupResults.innerHTML = '';
              });
              groupResults.appendChild(el);
            });
          });
      }, 300);
    });
  }

  if (createGroupBtn) {
    createGroupBtn.addEventListener('click', function() {
      if (selectedMembers.length < 1) return;
      createGroupBtn.disabled = true;
      createGroupBtn.textContent = '...';

      fetch('/messages/new-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          memberIds: selectedMembers.map(function(u) { return u.id; }),
          title: groupTitle.value.trim() || null,
        }),
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.conversationId) {
          window.location.href = '/' + LANG + '/messages/' + data.conversationId;
        }
      })
      .catch(function() {
        createGroupBtn.disabled = false;
        createGroupBtn.textContent = 'Create group';
      });
    });
  }
})();
