import type { SteamKeyboardRequest } from '../shared/types';

const textTypes = new Set(['text', 'search', 'email', 'password', 'number', 'tel', 'url']);
type TextField = HTMLInputElement | HTMLTextAreaElement;

export function isTextField(element: Element | null): element is TextField {
  if (!element || !element.isConnected) return false;
  const field = element as TextField;
  return !field.disabled && !field.readOnly && !field.closest('[hidden],[inert],[aria-hidden="true"]')
    && (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT' && textTypes.has(field.type));
}

/** Steam keyboard modes: 0 single line, 1 multiple lines, 2 email, 3 numeric. */
function keyboardMode(field: TextField): SteamKeyboardRequest['mode'] {
  if (field.tagName === 'TEXTAREA') return 1;
  if (field.type === 'email') return 2;
  return ['number', 'tel'].includes(field.type) ? 3 : 0;
}

/** One controller text-entry session, from a keyboard request until the user
 * finishes it. Steam exposes no reliable keyboard-visibility signal, so the
 * session ends explicitly with B or Escape. Enter can submit a search while
 * Steam keeps its keyboard open, so it must not release the controller gate. */
export type TextEntrySession = { field: TextField; id: number; multiline: boolean };

let session: TextEntrySession | undefined;
let sequence = 0;

/** The active text-entry session, if the pad must stay out of the way. */
export function activeTextEntry(): TextEntrySession | undefined {
  if (session && !isTextField(session.field)) session = undefined;
  return session;
}

/** The user finished text entry. Only the current session may be ended. */
export function endTextEntry(sessionId?: number): boolean {
  if (!session || sessionId !== undefined && session.id !== sessionId) return false;
  session = undefined;
  return true;
}

export function requestTextKeyboard(win: Window, field: TextField, show: (field: SteamKeyboardRequest) => Promise<unknown>): Promise<unknown> {
  if (!isTextField(field) || win.document.activeElement !== field) return Promise.resolve(false);
  field.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = field.getBoundingClientRect();
  if (!rect.width || !rect.height) return Promise.resolve(false);
  const current: TextEntrySession = { field, id: ++sequence, multiline: field.tagName === 'TEXTAREA' };
  session = current;
  const release = () => { if (session === current) session = undefined; };
  let pending: Promise<unknown>;
  try {
    pending = show({ x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height, mode: keyboardMode(field) });
  } catch (error) {
    release();
    throw error;
  }
  // A refused or failed request leaves no keyboard to type on. A late
  // completion belongs to its own session and must not clear a newer one.
  return pending.then(value => { if (value === false) release(); return value; }, error => { release(); throw error; });
}

/** Native touch release is reliable even when Chromium's compatibility click
 * lacks pointerType. Wait until the gesture's default focus action has run. */
export function installTouchKeyboard(win: Window, show: (field: SteamKeyboardRequest) => Promise<unknown>): () => void {
  let pending: number | undefined;
  const cancel = () => { if (pending !== undefined) win.cancelAnimationFrame(pending); pending = undefined; };
  const pointer = (event: PointerEvent) => {
    if (!event.isTrusted || !['touch', 'pen'].includes(event.pointerType)) return;
    const element = event.target as Element | null;
    if (!isTextField(element)) return;
    cancel();
    pending = win.requestAnimationFrame(() => {
      pending = undefined;
      void requestTextKeyboard(win, element, show).catch(() => {});
    });
  };
  win.addEventListener('pointerup', pointer, true);
  // Coalesce pointerup and its compatibility click into one request.
  win.addEventListener('click', pointer, true);
  win.addEventListener('pointercancel', cancel, true);
  return () => {
    cancel(); win.removeEventListener('pointerup', pointer, true); win.removeEventListener('click', pointer, true); win.removeEventListener('pointercancel', cancel, true);
  };
}
