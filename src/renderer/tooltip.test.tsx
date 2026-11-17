// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {act, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {placeTooltip, TooltipLayer, type TooltipRect} from './Tooltip';

const OPEN_DELAY = 500;
const HIDE_DELAY = 140;

let root: Root;
let originalElementFromPoint: PropertyDescriptor | undefined;
let originalHidden: PropertyDescriptor | undefined;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
};
const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const open = async () => { await advance(OPEN_DELAY); };
const render = async (node: ReactNode) => {
  await act(async () => { root.render(<>{node}<TooltipLayer/></>); });
};
const pointer = (type: string, target: EventTarget, init: {
  pointerType?: string; clientX?: number; clientY?: number; relatedTarget?: EventTarget | null;
} = {}) => {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true,
    clientX: init.clientX ?? 0, clientY: init.clientY ?? 0,
    relatedTarget: init.relatedTarget as EventTarget | null,
  });
  Object.defineProperty(event, 'pointerType', {value: init.pointerType ?? 'mouse'});
  target.dispatchEvent(event);
  return event;
};
const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(performance.now()), 0));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalElementFromPoint) Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
  else Reflect.deleteProperty(document, 'elementFromPoint');
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else Reflect.deleteProperty(document, 'hidden');
  document.body.innerHTML = '';
});

describe('in-window tooltip lifecycle', () => {
  it('opens on hover only after the dwell, preserves text and restores caller descriptions', async () => {
    await render(<button id="target" data-tooltip={'Full & <escaped>'} aria-describedby="existing help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    expect(tooltip()).toBeNull();
    expect(target.getAttribute('aria-describedby')).toBe('existing help');
    await advance(OPEN_DELAY - 1);
    expect(tooltip()).toBeNull();
    await advance(1);
    const surface = tooltip()!;
    expect(surface.textContent).toBe('Full & <escaped>');
    expect(surface.parentElement).toBe(document.body);
    expect(surface.hasAttribute('data-tooltip-layer')).toBe(true);
    expect(target.getAttribute('aria-describedby')).toBe(`existing help ${surface.id}`);
    await act(async () => { pointer('pointerout', target, {relatedTarget: document.body}); });
    await advance(HIDE_DELAY);
    expect(tooltip()).toBeNull();
    expect(target.getAttribute('aria-describedby')).toBe('existing help');
  });

  it('opens on keyboard focus only after the dwell and hides on focusout', async () => {
    await render(<button id="target" data-tooltip="Focus help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { target.focus(); });
    expect(tooltip()).toBeNull();
    await advance(OPEN_DELAY - 1);
    expect(tooltip()).toBeNull();
    await advance(1);
    const surface = tooltip()!;
    expect(surface.textContent).toBe('Focus help');
    expect(target.getAttribute('aria-describedby')).toBe(surface.id);
    await act(async () => { target.blur(); });
    await advance(HIDE_DELAY);
    expect(tooltip()).toBeNull();
    expect(target.hasAttribute('aria-describedby')).toBe(false);
  });

  it('opens on a gamepad focus marker only after the dwell and prefers the primary child title', async () => {
    await render(<div id="card" data-gamepad-card>
      <button id="card-button"><span data-tooltip="Price includes US tax">$9.99</span><strong data-tooltip="Full game title" data-tooltip-primary="">Game</strong></button>
    </div>);
    const card = document.getElementById('card')!;
    await act(async () => { card.setAttribute('data-gamepad-focus', ''); await flush(); });
    expect(tooltip()).toBeNull();
    await advance(OPEN_DELAY - 1);
    expect(tooltip()).toBeNull();
    await advance(1);
    const surface = tooltip()!;
    expect(surface.textContent).toBe('Full game title');
    expect(document.getElementById('card-button')!.getAttribute('aria-describedby')).toBe(surface.id);
  });

  it('shows an explicit descendant price/help tooltip on gamepad focus when there is no primary title', async () => {
    await render(<div id="card" data-gamepad-card>
      <button id="card-button"><span data-tooltip="Price includes US tax">$9.99</span></button>
    </div>);
    const button = document.getElementById('card-button')!;
    await act(async () => { button.focus(); });
    await open();
    const surface = tooltip()!;
    expect(surface.textContent).toBe('Price includes US tax');
    expect(button.getAttribute('aria-describedby')).toBe(surface.id);
    expect(button.querySelector('span')?.getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps the tooltip open while the pointer moves onto it', async () => {
    await render(<button id="target" data-tooltip="Hover help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await open();
    const surface = tooltip()!;
    await act(async () => { pointer('pointerout', target, {relatedTarget: document.body}); });
    await act(async () => { pointer('pointerover', surface); });
    await advance(HIDE_DELAY + 80);
    expect(tooltip()).toBe(surface);
    await act(async () => { pointer('pointerout', surface, {relatedTarget: document.body}); });
    expect(tooltip()).toBeNull();
  });

  it('keeps the tooltip open when the pointer crosses the gap onto its bounds', async () => {
    await render(<button id="target" data-tooltip="Hover help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await open();
    const surface = tooltip()!;
    Object.defineProperty(surface, 'getBoundingClientRect', {configurable: true, value: () => ({
      left: 200, top: 100, right: 400, bottom: 200, width: 200, height: 100, x: 200, y: 100, toJSON: () => ({}),
    } as DOMRect)});
    await act(async () => { pointer('pointerout', target, {relatedTarget: document.body}); });
    await act(async () => { pointer('pointermove', document.body, {clientX: 300, clientY: 150}); });
    await advance(HIDE_DELAY + 80);
    expect(tooltip()).toBe(surface);
  });

  it('keeps Escape dismissal across internal descendant pointer transitions and restores after leaving', async () => {
    await render(<button id="trigger" data-tooltip="Trigger help">
      <svg id="child-a" data-tooltip="Child A"><circle /></svg>
      <span id="child-b" data-tooltip="Child B">B</span>
    </button>);
    const trigger = document.getElementById('trigger')!;
    const a = document.getElementById('child-a')!;
    const b = document.getElementById('child-b')!;
    await act(async () => { trigger.focus(); });
    await open();
    expect(tooltip()?.textContent).toBe('Trigger help');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); });
    expect(tooltip()).toBeNull();
    await act(async () => { pointer('pointerout', a, {relatedTarget: b}); pointer('pointerover', b); });
    await open();
    expect(tooltip()).toBeNull();
    await act(async () => { pointer('pointerout', b, {relatedTarget: document.body}); pointer('pointerover', b); });
    await open();
    expect(tooltip()?.textContent).toBe('Child B');
  });

  it('keeps Escape dismissal across internal descendant focus transitions and restores after leaving', async () => {
    await render(<>
      <div id="trigger" tabIndex={0} data-tooltip="Trigger help">
        <button id="child-a" data-tooltip="Child A">A</button>
        <button id="child-b" data-tooltip="Child B">B</button>
      </div>
      <button id="outside">Outside</button>
    </>);
    const trigger = document.getElementById('trigger')!;
    const a = document.getElementById('child-a') as HTMLButtonElement;
    const b = document.getElementById('child-b') as HTMLButtonElement;
    const outside = document.getElementById('outside') as HTMLButtonElement;
    await act(async () => { trigger.focus(); });
    await open();
    expect(tooltip()?.textContent).toBe('Trigger help');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); });
    expect(tooltip()).toBeNull();
    await act(async () => { a.focus(); });
    await open();
    expect(tooltip()).toBeNull();
    await act(async () => { b.focus(); });
    await open();
    expect(tooltip()).toBeNull();
    await act(async () => { outside.focus(); });
    await act(async () => { b.focus(); });
    await open();
    expect(tooltip()?.textContent).toBe('Child B');
  });

  it('dismisses on Escape without consuming the key or breaking other key handling', async () => {
    await render(<button id="target" data-tooltip="Escape help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { target.focus(); });
    await open();
    expect(tooltip()).not.toBeNull();
    const key = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true});
    const other = vi.fn();
    window.addEventListener('keydown', other);
    await act(async () => { window.dispatchEvent(key); });
    window.removeEventListener('keydown', other);
    expect(tooltip()).toBeNull();
    expect(other).toHaveBeenCalledOnce();
    expect(key.defaultPrevented).toBe(false);
    await act(async () => { pointer('pointerover', target); });
    await open();
    expect(tooltip()).toBeNull();
    await act(async () => { target.blur(); });
    await advance(HIDE_DELAY);
    await act(async () => { target.focus(); });
    await open();
    expect(tooltip()?.textContent).toBe('Escape help');
  });

  it('hides on page scroll and resize but allows scrolling the tooltip itself', async () => {
    await render(<button id="target" data-tooltip="Scroll help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { target.focus(); });
    await open();
    const surface = tooltip()!;
    await act(async () => { surface.dispatchEvent(new Event('scroll')); });
    expect(tooltip()).toBe(surface);
    await act(async () => { window.dispatchEvent(new Event('scroll')); });
    expect(tooltip()).toBeNull();
    await act(async () => { target.blur(); });
    await advance(HIDE_DELAY);
    await act(async () => { target.focus(); });
    await open();
    expect(tooltip()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(tooltip()).toBeNull();
  });

  it('does not open on touch or a touch-induced focus', async () => {
    await render(<button id="target" data-tooltip="Touch help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => {
      pointer('pointerdown', target, {pointerType: 'touch'});
      target.focus();
      pointer('pointerover', target, {pointerType: 'touch'});
    });
    await open();
    expect(tooltip()).toBeNull();
  });

  it('removes dynamically added native title attributes before they can show', async () => {
    await render(<button id="target">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { target.setAttribute('title', 'Native title'); await flush(); });
    expect(target.hasAttribute('title')).toBe(false);
    expect(target.getAttribute('data-tooltip')).toBe('Native title');
    await act(async () => { target.focus(); });
    await open();
    expect(tooltip()?.textContent).toBe('Native title');
  });

  it('adopts title attributes on dynamically inserted markup', async () => {
    await render(<div id="host"></div>);
    const host = document.getElementById('host')!;
    await act(async () => { host.innerHTML = '<button id="added" title="Inserted native">Added</button>'; await flush(); });
    const added = document.getElementById('added')!;
    expect(added.hasAttribute('title')).toBe(false);
    expect(added.getAttribute('data-tooltip')).toBe('Inserted native');
  });

  it('shows disabled-button help through pointer hit testing', async () => {
    await render(<button id="disabled" disabled data-tooltip="Disabled help">Disabled</button>);
    const button = document.getElementById('disabled')!;
    Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => button});
    await act(async () => { pointer('pointermove', document.body, {clientX: 20, clientY: 20}); });
    await open();
    expect(tooltip()?.textContent).toBe('Disabled help');
  });

  it('removes the tooltip when its anchor is detached', async () => {
    const fixture = (shown: boolean) => <>{shown ? <button id="target" data-tooltip="Detached help">Target</button> : null}<TooltipLayer/></>;
    await act(async () => { root.render(fixture(true)); });
    const target = document.getElementById('target')!;
    await act(async () => { target.focus(); });
    await open();
    expect(tooltip()).not.toBeNull();
    await act(async () => { root.render(fixture(false)); await flush(); });
    expect(tooltip()).toBeNull();
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it('removes the portal and restores descriptions on unmount', async () => {
    await render(<button id="target" data-tooltip="Cleanup help" aria-describedby="caller">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { target.focus(); });
    await open();
    expect(tooltip()).not.toBeNull();
    await act(async () => { root.unmount(); });
    expect(tooltip()).toBeNull();
    expect(target.getAttribute('aria-describedby')).toBe('caller');
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
    root = createRoot(document.getElementById('root')!);
  });

  it('cancels a pending hover open when the pointer leaves before the deadline', async () => {
    await render(<button id="target" data-tooltip="Hover help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { pointer('pointerout', target, {relatedTarget: document.body}); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it('cancels a pending focus open when focus leaves before the deadline', async () => {
    await render(<button id="target" data-tooltip="Focus help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { target.focus(); });
    await advance(300);
    await act(async () => { target.blur(); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it('cancels a pending open on pointerdown', async () => {
    await render(<button id="target" data-tooltip="Pointer help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { pointer('pointerdown', target); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it.each([
    ['scroll', () => window.dispatchEvent(new Event('scroll'))],
    ['resize', () => window.dispatchEvent(new Event('resize'))],
    ['blur', () => window.dispatchEvent(new Event('blur'))],
  ])('cancels a pending open on %s', async (_name, cancel) => {
    await render(<button id="target" data-tooltip="Global help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { cancel(); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it('cancels a pending open when the document becomes hidden', async () => {
    await render(<button id="target" data-tooltip="Hidden help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    Object.defineProperty(document, 'hidden', {configurable: true, value: true});
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it('cancels a pending open on touch', async () => {
    await render(<button id="target" data-tooltip="Touch help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { pointer('pointerdown', target, {pointerType: 'touch'}); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it.each(['blur', 'scroll', 'resize', 'pointerleave', 'hidden'])('cancels a queued hit-test frame on %s', async kind => {
    await render(<button id="target" data-tooltip="Queued help">Target</button>);
    const target = document.getElementById('target')!;
    Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => target});
    await act(async () => { pointer('pointerover', target); });
    await act(async () => { pointer('pointermove', document.body, {clientX: 20, clientY: 20}); });
    await act(async () => {
      if (kind === 'blur') window.dispatchEvent(new Event('blur'));
      else if (kind === 'scroll') window.dispatchEvent(new Event('scroll'));
      else if (kind === 'resize') window.dispatchEvent(new Event('resize'));
      else if (kind === 'pointerleave') pointer('pointerout', target, {relatedTarget: document.body});
      else {
        Object.defineProperty(document, 'hidden', {configurable: true, value: true});
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it('switches anchors by cancelling the old pending open and starting a new dwell', async () => {
    await render(<>
      <button id="first" data-tooltip="First help">First</button>
      <button id="second" data-tooltip="Second help">Second</button>
    </>);
    const first = document.getElementById('first')!;
    const second = document.getElementById('second')!;
    await act(async () => { pointer('pointerover', first); });
    await advance(300);
    await act(async () => { pointer('pointerover', second); });
    await advance(200);
    expect(tooltip()).toBeNull();
    await advance(300);
    expect(tooltip()?.textContent).toBe('Second help');
  });

  it('does not reset the dwell on repeated pointermove over the same pending anchor', async () => {
    await render(<button id="target" data-tooltip="Move help">Target</button>);
    const target = document.getElementById('target')!;
    Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => target});
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { pointer('pointermove', document.body, {clientX: 20, clientY: 20}); });
    await flush();
    await advance(OPEN_DELAY - 301);
    expect(tooltip()).toBeNull();
    await advance(1);
    expect(tooltip()?.textContent).toBe('Move help');
  });

  it('does not reset the dwell on a repeated gamepad mark for the same pending anchor', async () => {
    await render(<div id="card" data-gamepad-card>
      <button id="card-button" data-tooltip="Game title">Game</button>
    </div>);
    const card = document.getElementById('card')!;
    const button = document.getElementById('card-button')!;
    await act(async () => { card.setAttribute('data-gamepad-focus', ''); await flush(); });
    await advance(300);
    await act(async () => { button.setAttribute('data-gamepad-focus', ''); await flush(); });
    await advance(OPEN_DELAY - 301);
    expect(tooltip()).toBeNull();
    await advance(1);
    expect(tooltip()?.textContent).toBe('Game title');
  });

  it('keeps a pending Escape dismissed until the pointer leaves and re-enters', async () => {
    await render(<button id="target" data-tooltip="Escape help">Target</button>);
    const target = document.getElementById('target')!;
    Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => target});
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
    await act(async () => { pointer('pointermove', document.body, {clientX: 20, clientY: 20}); });
    await flush();
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
    await act(async () => { pointer('pointerout', target, {relatedTarget: document.body}); });
    await act(async () => { pointer('pointerover', target); });
    await advance(OPEN_DELAY);
    expect(tooltip()?.textContent).toBe('Escape help');
  });

  it('cancels a pending open on unmount', async () => {
    await render(<button id="target" data-tooltip="Unmount help">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { root.unmount(); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
    root = createRoot(document.getElementById('root')!);
  });

  it('cancels a pending open when the anchor is detached', async () => {
    const fixture = (shown: boolean) => <>{shown ? <button id="target" data-tooltip="Detached help">Target</button> : null}<TooltipLayer/></>;
    await act(async () => { root.render(fixture(true)); });
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { root.render(fixture(false)); await flush(); });
    await advance(OPEN_DELAY);
    expect(tooltip()).toBeNull();
  });

  it('opens with the current text and never with stale pending text', async () => {
    await render(<button id="target" data-tooltip="Old text">Target</button>);
    const target = document.getElementById('target')!;
    await act(async () => { pointer('pointerover', target); });
    await advance(300);
    await act(async () => { target.setAttribute('data-tooltip', 'New text'); });
    await advance(200);
    expect(tooltip()?.textContent).toBe('New text');
  });

  it('hides the visible tooltip immediately and dwells before switching anchors', async () => {
    await render(<>
      <button id="first" data-tooltip="First help">First</button>
      <button id="second" data-tooltip="Second help">Second</button>
    </>);
    const first = document.getElementById('first')!;
    const second = document.getElementById('second')!;
    await act(async () => { pointer('pointerover', first); });
    await open();
    expect(tooltip()?.textContent).toBe('First help');
    await act(async () => { pointer('pointerover', second); });
    expect(tooltip()).toBeNull();
    expect(first.hasAttribute('aria-describedby')).toBe(false);
    await advance(OPEN_DELAY - 1);
    expect(tooltip()).toBeNull();
    await advance(1);
    expect(tooltip()?.textContent).toBe('Second help');
  });
});

describe('tooltip viewport placement', () => {
  const viewport = {width: 800, height: 600};
  const rect = (left: number, top: number, width = 100, height = 40): TooltipRect => ({
    left, top, right: left + width, bottom: top + height, width, height,
  });
  const inside = (position: ReturnType<typeof placeTooltip>, size: {width: number; height: number}, area = viewport) => {
    const width = Math.min(size.width, position.maxWidth);
    const height = Math.min(size.height, position.maxHeight);
    const edge = Math.min(8, area.width / 2, area.height / 2);
    expect(position.left).toBeGreaterThanOrEqual(edge);
    expect(position.top).toBeGreaterThanOrEqual(edge);
    expect(position.left + width).toBeLessThanOrEqual(area.width - edge + 0.001);
    expect(position.top + height).toBeLessThanOrEqual(area.height - edge + 0.001);
  };

  it('flips below the top edge and above the bottom edge', () => {
    const top = placeTooltip(rect(300, 10), {width: 200, height: 50}, viewport);
    expect(top.placement).toBe('bottom');
    inside(top, {width: 200, height: 50});
    const bottom = placeTooltip(rect(300, 550), {width: 200, height: 50}, viewport);
    expect(bottom.placement).toBe('top');
    inside(bottom, {width: 200, height: 50});
  });

  it('flips to the right and left at horizontal edges when vertical space is unavailable', () => {
    const narrow = {width: 800, height: 200};
    const right = placeTooltip(rect(5, 50, 100, 100), {width: 200, height: 100}, narrow);
    expect(right.placement).toBe('right');
    inside(right, {width: 200, height: 100}, narrow);
    const left = placeTooltip(rect(695, 50, 100, 100), {width: 200, height: 100}, narrow);
    expect(left.placement).toBe('left');
    inside(left, {width: 200, height: 100}, narrow);
  });

  it('clamps every edge inside the viewport', () => {
    for (const anchor of [rect(0, 0), rect(700, 0), rect(0, 560), rect(700, 560), rect(350, 280)]) {
      const position = placeTooltip(anchor, {width: 220, height: 80}, viewport);
      inside(position, {width: 220, height: 80});
    }
  });

  it('keeps long text scrollable without making ordinary tooltips intercept pointers', () => {
    const css = readFileSync('src/renderer/tooltip.css', 'utf8');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('.nexus-tooltip[data-scrollable="true"]');
    expect(css).toContain('pointer-events: auto');
    expect(css).toContain('@media (max-width: 40px), (max-height: 40px)');
    expect(css).toContain('padding: 0');
    expect(css).toContain('border: 0');
    expect(css).toContain('overflow: hidden');
  });

  it('bounds long unbroken and localized text on a tiny viewport', () => {
    const long = placeTooltip(rect(300, 300), {width: 1000, height: 500}, viewport);
    expect(long.maxWidth).toBe(360);
    expect(long.maxHeight).toBe(584);
    inside(long, {width: 1000, height: 500});
    const tiny = {width: 20, height: 20};
    const mini = placeTooltip(rect(5, 5, 10, 10), {width: 100, height: 100}, tiny);
    expect(mini.maxWidth).toBe(4);
    expect(mini.maxHeight).toBe(4);
    expect(mini.left).toBe(8);
    expect(mini.top).toBe(8);
    inside(mini, {width: 100, height: 100}, tiny);
    const micro = {width: 10, height: 10};
    const smallest = placeTooltip(rect(2, 2, 2, 2), {width: 100, height: 100}, micro);
    expect(smallest.maxWidth).toBe(0);
    expect(smallest.maxHeight).toBe(0);
    expect(smallest.left).toBe(5);
    expect(smallest.top).toBe(5);
    inside(smallest, {width: 100, height: 100}, micro);
  });
});
