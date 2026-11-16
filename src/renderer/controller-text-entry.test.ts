// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGamepadNavigation } from './gamepad-navigation';
import { gamepadHarness } from './gamepad-test-harness';
import { requestTextKeyboard } from './touch-keyboard';

/** Controller text entry: while a Steam keyboard request is pending or resolved,
 * the pad must not move focus or activate the launcher behind the keyboard. */
const get = (id: string) => document.getElementById(id)!;
const search = () => get('search') as HTMLInputElement;
let stop: (() => void) | undefined;
let harness: ReturnType<typeof gamepadHarness>;
let keyboard: ReturnType<typeof vi.fn>;
let back: ReturnType<typeof vi.fn>;
let page: ReturnType<typeof vi.fn>;
let social: ReturnType<typeof vi.fn>;
let ySearch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = `<aside class="sidebar"><button id="home" class="nav-item active" data-test-rect="0,100,100,40">Home</button></aside>
    <section class="content-shell"><header class="topbar"><div class="search-box"><input id="search" type="search" value="kept" data-test-rect="300,10,300,40"></div></header>
    <div class="page-scroll" data-gamepad-page="home"><main class="home-page">
      <button id="first" data-test-rect="300,120,300,40">First</button>
      <button id="second" data-test-rect="300,200,300,40">Second</button>
      <input id="name" data-test-rect="300,280,300,40">
      <textarea id="notes" data-test-rect="300,360,300,80"></textarea>
    </main></div></section>`;
  harness = gamepadHarness();
  keyboard = vi.fn(async () => true);
  back = vi.fn(); page = vi.fn(); social = vi.fn();
  // The App's Y route focuses search and requests the keyboard outside this module.
  ySearch = vi.fn(() => { search().focus(); void requestTextKeyboard(window, search(), field => keyboard(field)).catch(() => {}); });
  stop = installGamepadNavigation(window, { mode: vi.fn(), back, page, social, search: ySearch, keyboard });
  harness.step();
});
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); document.body.innerHTML = ''; });

/** Enter text entry the way the user does: A on the focused field. */
const openField = (id: string) => { get(id).focus(); harness.step(); harness.press(0); };
/** Finish text entry the way the user does: B. */
const closeWithB = () => { harness.press(1); harness.step(); };

describe('controller text entry gate', () => {
  it.each([[12], [13], [14], [15]])('keeps D-pad %s from moving focus while a request is pending', async button => {
    let resolve!: (value: boolean) => void;
    keyboard.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
    openField('name');
    expect(keyboard).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(get('name'));
    harness.press(button); harness.press(button);
    expect(document.activeElement).toBe(get('name'));
    expect(get('name').hasAttribute('data-gamepad-focus')).toBe(true);
    harness.press(button);
    resolve(true); await Promise.resolve();
    harness.press(button);
    expect(document.activeElement).toBe(get('name'));
  });

  it('does not activate a launcher control with A or B while text entry is active', async () => {
    const click = vi.fn(); get('first').onclick = click; get('home').onclick = click;
    openField('first'); // A on a button is ordinary navigation, not text entry.
    expect(keyboard).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
    harness.step(); click.mockClear();
    openField('name');
    harness.press(0); harness.press(0);
    expect(click).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(get('name'));
  });

  it('does not scroll on the same frame that A starts text entry', () => {
    const content = document.querySelector<HTMLElement>('.page-scroll')!;
    content.style.overflowY = 'auto';
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(content, 'clientHeight', { configurable: true, value: 500 });
    get('name').focus(); harness.step();
    harness.step([0], [0, 0, 0, 0.9]);
    expect(keyboard).toHaveBeenCalledOnce();
    expect(content.scrollTop).toBe(0);
    expect(document.activeElement).toBe(get('name'));
  });

  it('pauses right-stick scroll, shoulders, options, search and social during text entry', async () => {
    const content = document.querySelector<HTMLElement>('.page-scroll')!;
    content.style.overflowY = 'auto';
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(content, 'clientHeight', { configurable: true, value: 500 });
    openField('name');
    const before = content.scrollTop;
    harness.step([], [0, 0, 0, 0.9]); harness.step([], [0, 0, 0, 0.9]);
    expect(content.scrollTop).toBe(before);
    harness.step([], [0, 0, 0, 0]); // neutral right stick
    harness.press(4); harness.press(5); harness.press(2); harness.press(3); harness.press(8);
    expect(page).not.toHaveBeenCalled(); expect(social).not.toHaveBeenCalled(); expect(ySearch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(get('name'));
  });

  it('ends text entry with B without page back, search clear or a hidden activation', async () => {
    openField('search');
    expect(keyboard).toHaveBeenCalledOnce();
    harness.step([1]); // Close the OSK, keeping B physically held.
    expect(back).not.toHaveBeenCalled();
    expect(search().value).toBe('kept');
    expect(document.activeElement).toBe(search());
    harness.step([1]); harness.step([1]);
    expect(back).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search());
    expect(search().value).toBe('kept');
    harness.step(); // One neutral frame is sufficient, just like ordinary PadInput.
    harness.press(1); // A fresh B leaves search instead of being swallowed again.
    expect(document.activeElement).toBe(get('first'));
    harness.press(1);
    expect(back).toHaveBeenCalledOnce();
  });

  it('treats pad A as letter selection and keeps the pad paused until B', async () => {
    openField('name');
    expect(keyboard).toHaveBeenCalledOnce();
    harness.press(0); harness.step(); // A selects a letter on the Steam keyboard.
    harness.press(0); harness.step();
    expect(keyboard).toHaveBeenCalledOnce();
    harness.press(13); harness.press(12); harness.press(15);
    expect(document.activeElement).toBe(get('name'));
    expect(back).not.toHaveBeenCalled();
    harness.press(1); harness.step(); harness.step(); // B ends text entry, then neutral.
    harness.press(13);
    expect(document.activeElement).toBe(get('notes'));
  });

  it('keeps single-line text entry after Enter submits while the keyboard stays open', async () => {
    openField('name');
    harness.press(0); // A is only a letter.
    expect(keyboard).toHaveBeenCalledOnce();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    get('name').dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false); // Submission still reaches the field/app.
    harness.step(); harness.press(13); harness.press(12);
    expect(document.activeElement).toBe(get('name'));
    harness.press(1); harness.step(); harness.press(13);
    expect(document.activeElement).toBe(get('notes'));
  });

  it('keeps a multiline session editing when Enter is pressed', async () => {
    openField('notes');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    harness.step();
    harness.press(13); harness.press(12); harness.press(15);
    expect(document.activeElement).toBe(get('notes'));
    expect(back).not.toHaveBeenCalled();
    harness.press(1); harness.step(); harness.step();
    harness.press(12); harness.press(12);
    expect(document.activeElement).not.toBe(get('notes'));
  });

  it.each([['textarea', 'notes'], ['input', 'name']])('ends %s text entry with Escape', async (tag, id) => {
    openField(id);
    expect(get(id).tagName.toLowerCase()).toBe(tag);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    harness.step();
    // The field keeps its focus for typing, but the pad navigates again.
    expect(document.activeElement).toBe(get(id));
    harness.press(12); harness.press(12); harness.press(12);
    expect(document.activeElement).not.toBe(get(id));
  });

  it('covers the Y search route requested outside gamepad-navigation', async () => {
    get('first').focus(); harness.step();
    harness.press(3);
    expect(ySearch).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(search());
    harness.press(13);
    expect(document.activeElement).toBe(search());
    harness.press(1); harness.step();
    expect(back).not.toHaveBeenCalled();
    expect(search().value).toBe('kept');
    harness.press(13);
    expect(document.activeElement).not.toBe(search());
  });

  it.each([['refuses', async () => false], ['rejects', async () => { throw new Error('unavailable'); }]])('releases the gate when Steam %s the request', async (_name, result) => {
    keyboard.mockImplementation(result as () => Promise<boolean>);
    openField('name');
    await Promise.resolve(); await Promise.resolve(); // A is still held.
    harness.step(); // Observe the settled refusal on a neutral frame.
    harness.press(13);
    expect(document.activeElement).toBe(get('notes'));
  });

  it.each([['refuse', async () => false], ['reject', async () => { throw new Error('unavailable'); }]])(
    'needs neutral after a %s while A is held, so it cannot resend the request', async (_name, result) => {
      keyboard.mockImplementation(result as () => Promise<boolean>);
      get('name').focus(); harness.step();
      harness.step([0]); // A starts the request and remains physically held.
      await Promise.resolve(); await Promise.resolve();
      harness.step([0]); harness.step([0]);
      expect(keyboard).toHaveBeenCalledOnce();
      expect(back).not.toHaveBeenCalled();
      harness.step(); // Actual release/neutral, not press() which releases immediately.
      harness.step([0]); // A fresh press may request the keyboard again.
      expect(keyboard).toHaveBeenCalledTimes(2);
    });

  it('never opens a session for an ineligible field or without a focused field', async () => {
    const select = document.createElement('select'); select.id = 'choice'; select.dataset.testRect = '300,440,300,40';
    select.innerHTML = '<option>One</option>'; document.querySelector('main')!.append(select);
    select.focus(); harness.step(); harness.press(0);
    expect(keyboard).not.toHaveBeenCalled();
    harness.press(13); // The select picker still navigates.
    expect(document.querySelector('.gamepad-select-dialog')).not.toBeNull();
  });

  it('ignores a late older completion so it cannot clear a newer session', async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    keyboard.mockImplementation(() => new Promise<boolean>(done => { resolvers.push(done); }));
    openField('name');
    harness.press(1); harness.step(); // B ends the first session.
    harness.press(13); // Navigation resumed.
    expect(document.activeElement).not.toBe(get('name'));
    get('name').focus(); harness.step(); harness.press(0); // A starts a new session.
    expect(resolvers).toHaveLength(2);
    resolvers[0](false); await Promise.resolve(); await Promise.resolve();
    harness.press(13);
    expect(document.activeElement).toBe(get('name')); // New session still holds.
    resolvers[1](true); await Promise.resolve(); await Promise.resolve();
    harness.press(1); harness.step(); harness.press(13);
    expect(document.activeElement).not.toBe(get('name'));
  });

  it('keeps ordinary navigation unchanged when no keyboard is requested', async () => {
    keyboard.mockImplementation(async () => false);
    get('first').focus(); harness.step();
    harness.press(13);
    expect(document.activeElement).toBe(get('second'));
    harness.press(1);
    expect(back).toHaveBeenCalledOnce();
  });

  it('needs neutral after B, so a held right stick cannot scroll the underlay', async () => {
    const content = document.querySelector<HTMLElement>('.page-scroll')!;
    content.style.overflowY = 'auto';
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(content, 'clientHeight', { configurable: true, value: 500 });
    openField('name');
    harness.step([], [0, 0, 0, 0.9]); // right stick held during text entry
    harness.step([], [0, 0, 0, 0.9]);
    harness.step([1], [0, 0, 0, 0.9]); // B ends entry while the right stick stays held.
    const before = content.scrollTop;
    harness.step([], [0, 0, 0, 0.9]);
    expect(content.scrollTop).toBe(before);
    harness.step([], [0, 0, 0, 0]); // neutral
    harness.step([], [0, 0, 0, 0.9]);
    expect(content.scrollTop).toBeGreaterThan(before);
  });

  it('does not clear the gate when the OSK window takes window focus', async () => {
    openField('name');
    vi.mocked(document.hasFocus).mockReturnValue(false);
    harness.step(); harness.step();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    harness.step();
    harness.press(13);
    expect(document.activeElement).toBe(get('name'));
  });

  it('releases the gate when the field is removed or disabled', async () => {
    openField('name');
    get('name').remove();
    harness.step();
    harness.press(13);
    expect(document.activeElement).not.toBe(get('name'));
    harness.press(12); get('first').focus(); harness.step(); harness.press(0);
    expect(keyboard).toHaveBeenCalledTimes(1); // A on a button is not text entry.
    get('notes').focus(); harness.step(); harness.press(0);
    expect(keyboard).toHaveBeenCalledTimes(2);
    (get('notes') as HTMLTextAreaElement).disabled = true;
    harness.step(); harness.step(); harness.press(12); harness.press(12); harness.press(12);
    expect(document.activeElement).not.toBe(get('notes'));
  });

  it('hands text entry off when the pointer focuses another control', async () => {
    openField('name');
    get('first').focus();
    window.dispatchEvent(new Event('pointerdown'));
    harness.step();
    harness.press(13);
    expect(document.activeElement).not.toBe(get('name'));
  });
});
