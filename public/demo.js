// public/demo.js
// Drives the controlled crash and renders the resulting trace card.
// All text is written with textContent.

(function () {
  'use strict';

  var crashBtn = document.getElementById('crashBtn');
  var recLabel = document.getElementById('recLabel');
  var recDot = document.getElementById('recDot');
  var maskPill = document.getElementById('maskPill');
  var bufferCount = document.getElementById('bufferCount');
  var uploadCount = document.getElementById('uploadCount');
  var out = document.getElementById('out');
  var hint = document.getElementById('demoHint');

  if (!crashBtn) return;

  var uploads = 0;
  var armed = false;
  var pending = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setArmed(state) {
    armed = state;
    recLabel.textContent = state ? 'Recorder armed' : 'Recorder starting…';
    recDot.style.background = state ? '' : '#c9cfda';
    recDot.style.animation = state ? '' : 'none';
  }

  function toast(message) {
    var node = document.getElementById('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () {
      node.classList.remove('show');
    }, 2400);
  }

  window.addEventListener('dvr:ready', function (event) {
    var detail = (event && event.detail) || {};
    setArmed(true);
    if (detail.masking !== false) maskPill.hidden = false;
    if (detail.windowSec) {
      hint.textContent = 'Recording the last ' + detail.windowSec + ' seconds. Nothing leaves this machine.';
    }
  });

  window.addEventListener('dvr:buffer', function (event) {
    var count = (event && event.detail && event.detail.count) || 0;
    bufferCount.textContent = String(count);
    if (!armed) setArmed(true);
  });

  window.addEventListener('dvr:uploaded', function (event) {
    var data = (event && event.detail) || {};
    uploads += 1;
    uploadCount.textContent = String(uploads);
    pending = false;
    crashBtn.disabled = false;
    crashBtn.querySelector('span').textContent = 'Run controlled crash';

    if (!data.sliceId) {
      hint.textContent = 'The slice uploaded but the server returned no id.';
      return;
    }

    hint.textContent = 'Slice captured. Open it to replay the lead-up.';

    out.textContent = '';

    var card = el('div', 'result');

    var head = el('div', 'result-head');
    head.appendChild(el('span', 'sev ' + (data.severity || 'critical')));
    head.appendChild(el('strong', null, 'Trace captured'));
    var chip = el('span', 'chip-soft', (data.severity || 'critical'));
    chip.style.marginLeft = 'auto';
    head.appendChild(chip);
    card.appendChild(head);

    var idRow = el('div', 'result-id');
    idRow.appendChild(el('code', null, data.sliceId));
    card.appendChild(idRow);

    var actions = el('div', 'result-actions');
    var open = el('button', 'btn primary sm', 'Open replay');
    open.type = 'button';
    open.addEventListener('click', function () {
      window.location.href = '/replay/' + encodeURIComponent(data.sliceId);
    });
    var copy = el('button', 'btn sm', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var link = window.location.origin + '/replay/' + encodeURIComponent(data.sliceId);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(
          function () { toast('Link copied — the recipient still needs the admin token.'); },
          function () { toast('Copy failed.'); }
        );
      } else {
        toast('Copy failed.');
      }
    });
    actions.appendChild(open);
    actions.appendChild(copy);
    card.appendChild(actions);

    var meta = el(
      'p',
      'result-meta',
      (data.eventCount || 0) + ' events · ' + (data.pageLabel || 'page') + ' · replay opens in this tab'
    );
    card.appendChild(meta);

    out.appendChild(card);
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  crashBtn.addEventListener('click', function () {
    if (pending) return;
    pending = true;
    crashBtn.disabled = true;
    crashBtn.querySelector('span').textContent = 'Capturing trace…';
    hint.textContent = 'The error is firing now — the SDK is uploading the window.';

    // Give the recorder one frame to include the click, then fail for real.
    window.setTimeout(function () {
      console.log('About to crash...');
      var cart = null;
      // Deliberate TypeError: reading a property of null.
      console.log(cart.total);
    }, 120);

    // Safety net: never leave the button stuck if the upload never reports.
    window.setTimeout(function () {
      if (!pending) return;
      pending = false;
      crashBtn.disabled = false;
      crashBtn.querySelector('span').textContent = 'Run controlled crash';
      hint.textContent = 'No upload came back — check the server console.';
    }, 12000);
  });
})();
