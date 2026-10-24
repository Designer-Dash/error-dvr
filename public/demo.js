// public/demo.js
// Drives the interactive e-commerce store browsing, buffer selection,
// controlled crash simulation, and renders the resulting trace card into #out.

(function () {
  'use strict';

  var crashBtn = document.getElementById('crashBtn');
  var payOrderBtn = document.getElementById('payOrderBtn');
  var recLabel = document.getElementById('recLabel');
  var recDot = document.getElementById('recDot');
  var maskPill = document.getElementById('maskPill');
  var bufferCount = document.getElementById('bufferCount');
  var uploadCount = document.getElementById('uploadCount');
  var out = document.getElementById('out');
  var hint = document.getElementById('demoHint');
  var freezeOverlay = document.getElementById('freezeOverlay');
  var resetDemoBtn = document.getElementById('resetDemoBtn');
  var capturedBufferPill = document.getElementById('capturedBufferPill');
  var reloadBtn = document.getElementById('reloadBtn');
  var cartCountBadge = document.getElementById('cartCountBadge');
  var subtotalPrice = document.getElementById('subtotalPrice');
  var totalPrice = document.getElementById('totalPrice');

  var uploads = 0;
  var armed = false;
  var pending = false;
  var currentBufferSec = 15;
  var cartTotal = 498;
  var cartItemsCount = 2;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setArmed(state) {
    armed = state;
    if (recLabel) recLabel.textContent = state ? 'Recorder armed' : 'Recorder starting…';
    if (recDot) {
      recDot.style.background = state ? '' : '#c9cfda';
      recDot.style.animation = state ? '' : 'none';
    }
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

  // ------------------------------------------------ DVR BUFFER SELECTOR --

  var bufButtons = document.querySelectorAll('.buf-btn');
  Array.prototype.forEach.call(bufButtons, function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(bufButtons, function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var sec = Number(btn.getAttribute('data-sec')) || 15;
      currentBufferSec = sec;
      if (capturedBufferPill) capturedBufferPill.textContent = sec + 's Pre-Crash Buffer';
      window.dispatchEvent(new CustomEvent('dvr:set-window', { detail: { seconds: sec } }));
      toast('DVR rolling buffer set to last ' + sec + ' seconds');
    });
  });

  // ------------------------------------------------- INTERACTIVE STORE --

  // Add to cart buttons
  var addBtns = document.querySelectorAll('.add-to-cart-btn');
  Array.prototype.forEach.call(addBtns, function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.getAttribute('data-name') || 'Item';
      var price = Number(btn.getAttribute('data-price')) || 99;
      cartTotal += price;
      cartItemsCount += 1;

      if (cartCountBadge) cartCountBadge.textContent = String(cartItemsCount);
      if (subtotalPrice) subtotalPrice.textContent = '$' + cartTotal + '.00';
      if (totalPrice) totalPrice.textContent = '$' + cartTotal + '.00';
      if (payOrderBtn) payOrderBtn.querySelector('span').textContent = 'Pay & Place Order ($' + cartTotal + '.00)';

      // Simulated network call to add to cart
      try {
        window.fetch('/api/cart/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item: name, price: price, at: Date.now() }),
        }).catch(function () {});
      } catch (e) {}

      console.log('[Store] Added item to cart: ' + name + ' ($' + price + ')');
      toast('Added "' + name + '" to cart! Total: $' + cartTotal);
    });
  });

  if (reloadBtn) {
    reloadBtn.addEventListener('click', function () {
      window.location.reload();
    });
  }

  // ---------------------------------------------------- CRASH TRIGGER --

  function triggerCrash() {
    if (pending) return;
    pending = true;
    if (crashBtn) {
      crashBtn.disabled = true;
      var span = crashBtn.querySelector('span');
      if (span) span.textContent = 'Capturing trace…';
    }
    if (hint) hint.textContent = 'The error is firing now — the SDK is uploading the window.';
    var declinedDisplay = document.getElementById('declinedTotalDisplay');
    if (declinedDisplay) declinedDisplay.textContent = '$' + cartTotal + '.00';
    if (freezeOverlay) freezeOverlay.hidden = false;
    if (recLabel) recLabel.textContent = 'Recorder triggered (uploading slice…)';

    // Give the recorder one frame to include the click, then fail for real.
    window.setTimeout(function () {
      console.log('About to crash...');
      var cart = null;
      // Deliberate TypeError: reading a property of null.
      console.log(cart.total);
    }, 50);

    window.setTimeout(function () {
      if (!pending) return;
      pending = false;
      if (crashBtn) {
        crashBtn.disabled = false;
        var s = crashBtn.querySelector('span');
        if (s) s.textContent = 'Run controlled crash';
      }
    }, 12000);
  }

  var btnToggleAdminView = document.getElementById('btnToggleAdminView');
  if (btnToggleAdminView) {
    btnToggleAdminView.addEventListener('click', function () {
      var adminSec = document.getElementById('adminTelemetrySection');
      if (adminSec) {
        adminSec.classList.toggle('highlight-pulse');
        adminSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  if (crashBtn) {
    crashBtn.addEventListener('click', triggerCrash);
  }

  if (payOrderBtn) {
    payOrderBtn.addEventListener('click', function (e) {
      e.preventDefault();
      triggerCrash();
    });
  }

  if (resetDemoBtn) {
    resetDemoBtn.addEventListener('click', function () {
      if (freezeOverlay) freezeOverlay.hidden = true;
      setArmed(true);
      toast('Session reset. You can browse and test again.');
    });
  }

  // ---------------------------------------------------- DVR EVENTS --

  window.addEventListener('dvr:ready', function (event) {
    var detail = (event && event.detail) || {};
    setArmed(true);
    if (detail.masking !== false && maskPill) maskPill.hidden = false;
    if (detail.windowSec && hint) {
      hint.textContent = 'Recording the last ' + detail.windowSec + ' seconds. Nothing leaves this machine.';
    }
  });

  window.addEventListener('dvr:buffer', function (event) {
    var count = (event && event.detail && event.detail.count) || 0;
    if (bufferCount) bufferCount.textContent = String(count);
    if (!armed) setArmed(true);
  });

  window.addEventListener('dvr:uploaded', function (event) {
    var data = (event && event.detail) || {};
    uploads += 1;
    if (uploadCount) uploadCount.textContent = String(uploads);
    if (recLabel) recLabel.textContent = 'Recorder armed';

    if (!data.sliceId) {
      if (hint) hint.textContent = 'The slice uploaded but the server returned no id.';
      return;
    }

    if (hint) hint.textContent = 'Slice captured. Open it to replay the lead-up.';

    if (out) {
      out.textContent = '';

      var card = el('div', 'result');

      var head = el('div', 'result-head');
      head.appendChild(el('span', 'sev ' + (data.severity || 'critical')));
      head.appendChild(el('strong', null, 'Trace Captured & Preserved'));
      var chip = el('span', 'chip-soft', (data.severity || 'critical'));
      chip.style.marginLeft = 'auto';
      head.appendChild(chip);
      card.appendChild(head);

      var idRow = el('div', 'result-id');
      idRow.appendChild(el('code', null, data.sliceId));
      card.appendChild(idRow);

      var actions = el('div', 'result-actions');
      var open = el('button', 'btn primary sm', '🔒 Open Replay in Admin Portal');
      open.type = 'button';
      open.addEventListener('click', function () {
        window.location.href = '/replay/' + encodeURIComponent(data.sliceId);
      });
      var copy = el('button', 'btn sm secondary', 'Copy Trace Link');
      copy.type = 'button';
      copy.addEventListener('click', function () {
        var link = window.location.origin + '/replay/' + encodeURIComponent(data.sliceId);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(function () {
            toast('Admin trace link copied!');
          });
        }
      });
      actions.appendChild(open);
      actions.appendChild(copy);
      card.appendChild(actions);

      out.appendChild(card);
    }
  });

  // Default armed state
  setArmed(true);
})();
