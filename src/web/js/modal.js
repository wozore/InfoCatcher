/**
 * modal.js — 全站通用模态对话框管理器
 * 管理 #modalOverlay 显示、焦点锁定、回焦与滚动位置恢复。
 */

let modalTrigger = null;
let modalScrollPosition = null;

export function setModalScrollPosition(value) {
  modalScrollPosition = value;
}

export function getModalFocusableElements() {
  const content = document.getElementById('modalContent');
  if (!content) return [];
  return [...content.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getClientRects().length > 0);
}

export function configureModalAccessibility() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  const title = content?.querySelector('h2, .model-panel-heading h4');
  const description = content?.querySelector('.vendor-description, .node-description, .vendor, .section p');
  if (!overlay || !content) return;
  if (title) title.id = 'modalTitle';
  if (description) {
    description.id = 'modalDescription';
    overlay.setAttribute('aria-describedby', 'modalDescription');
  } else {
    overlay.removeAttribute('aria-describedby');
  }
}

export function showModal(trigger = null) {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  if (!overlay || !content) return;
  const explicitTrigger = trigger instanceof HTMLElement
    ? (trigger.matches('a[href], button, [tabindex]:not([tabindex="-1"])') ? trigger : trigger.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])'))
    : null;
  modalTrigger = explicitTrigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  configureModalAccessibility();
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  const focusTarget = content.querySelector('.modal-close') || content;
  focusTarget.focus();
}

export function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove('modal-open');
  const returnTarget = modalTrigger;
  const scrollPosition = modalScrollPosition;
  modalTrigger = null;
  modalScrollPosition = null;
  if (scrollPosition !== null) window.scrollTo({ top: scrollPosition, behavior: 'auto' });
  if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
}
