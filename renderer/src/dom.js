'use strict';
const { config } = require('./state');

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), config.TOAST_DURATION_MS);
}

function showLoading(text) {
  $('loadingText').textContent = text || 'Working...';
  $('loading').classList.add('open');
}
function hideLoading() { $('loading').classList.remove('open'); }

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
function closeAllModals() {
  document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
}

const screenChangeListeners = [];
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  for (const cb of screenChangeListeners) {
    try { cb(id); } catch (e) { console.error(e); }
  }
}
function onScreenChange(cb) { screenChangeListeners.push(cb); }

module.exports = {
  $, toast,
  showLoading, hideLoading,
  openModal, closeModal, closeAllModals,
  showScreen, onScreenChange
};
