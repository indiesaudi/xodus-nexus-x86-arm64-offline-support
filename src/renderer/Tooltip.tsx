import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import './tooltip.css';

const TOOLTIP_ATTRIBUTE = 'data-tooltip';
/** Marks the child text that best represents an ancestor control on focus. */
const PRIMARY_ATTRIBUTE = 'data-tooltip-primary';
const LAYER_SELECTOR = '[data-tooltip-layer]';
const CONTROL_SELECTOR = 'button,a[href],input:not([type="hidden"]),select,textarea,summary,[tabindex]';
const DESCENDANT_CONTROL_SELECTOR = 'button,a[href],input:not([type="hidden"]),select,textarea,summary';
const MARGIN = 8;
const GAP = 6;
const MAX_WIDTH = 360;
const HIDE_DELAY = 140;

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export type TooltipRect = {left: number; top: number; right: number; bottom: number; width: number; height: number};
export type TooltipSize = {width: number; height: number};
export type TooltipViewport = {width: number; height: number};
export type TooltipPosition = {left: number; top: number; placement: TooltipPlacement; maxWidth: number; maxHeight: number};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Place a fixed tooltip fully inside the viewport. Prefer above and below,
 * then the sides, and clamp the least-overflowing side on tiny viewports. */
export function placeTooltip(anchor: TooltipRect, size: TooltipSize, viewport: TooltipViewport, margin = MARGIN, gap = GAP): TooltipPosition {
  // Shrink the safety margin on viewports smaller than twice the normal
  // margin so a bounded tooltip remains representable even at extreme sizes.
  const edge = Math.min(margin, Math.max(0, viewport.width / 2), Math.max(0, viewport.height / 2));
  const maxWidth = Math.max(0, Math.min(MAX_WIDTH, viewport.width - edge * 2));
  const maxHeight = Math.max(0, viewport.height - edge * 2);
  const width = Math.min(Math.max(0, size.width), maxWidth);
  const height = Math.min(Math.max(0, size.height), maxHeight);
  const space: Record<TooltipPlacement, number> = {
    top: anchor.top - edge,
    bottom: viewport.height - anchor.bottom - edge,
    left: anchor.left - edge,
    right: viewport.width - anchor.right - edge,
  };
  const needed: Record<TooltipPlacement, number> = {
    top: height + gap,
    bottom: height + gap,
    left: width + gap,
    right: width + gap,
  };
  const order: TooltipPlacement[] = ['top', 'bottom', 'right', 'left'];
  let placement = order.find(side => space[side] >= needed[side]);
  if (!placement) {
    placement = order.reduce((best, side) => space[side] - needed[side] > space[best] - needed[best] ? side : best, order[0]);
  }
  let left: number, top: number;
  if (placement === 'top' || placement === 'bottom') {
    left = anchor.left + (anchor.width - width) / 2;
    top = placement === 'top' ? anchor.top - height - gap : anchor.bottom + gap;
  } else {
    left = placement === 'left' ? anchor.left - width - gap : anchor.right + gap;
    top = anchor.top + (anchor.height - height) / 2;
  }
  return {
    left: clamp(left, edge, viewport.width - width - edge),
    top: clamp(top, edge, viewport.height - height - edge),
    placement,
    maxWidth,
    maxHeight,
  };
}

const asElement = (value: EventTarget | null | undefined): Element | undefined =>
  typeof Element !== 'undefined' && value instanceof Element ? value : undefined;

const tooltipValue = (element: Element): string => element.getAttribute(TOOLTIP_ATTRIBUTE) ?? '';

const inLayer = (element: Element): boolean => Boolean(element.closest(LAYER_SELECTOR));

/** Resolve the nearest explicit tooltip for a pointer target. When a real
 * control has no tooltip of its own, use its primary child text or badge
 * description, never a nested control's tooltip. */
export function resolveTooltipAnchor(target: Element | null): HTMLElement | undefined {
  if (!target || inLayer(target)) return;
  const control = target.closest<HTMLElement>(CONTROL_SELECTOR);
  const direct = target.closest<HTMLElement>(`[${TOOLTIP_ATTRIBUTE}]`);
  if (direct && !inLayer(direct) && tooltipValue(direct).trim() && (!control || control === direct || control.contains(direct))) return direct;
  if (!control || !control.matches(DESCENDANT_CONTROL_SELECTOR)) return;
  const candidates = [...control.querySelectorAll<HTMLElement>(`[${TOOLTIP_ATTRIBUTE}]`)]
    .filter(element => !inLayer(element) && tooltipValue(element).trim() && element.closest(CONTROL_SELECTOR) === control);
  return candidates.find(element => element.hasAttribute(PRIMARY_ATTRIBUTE)) ?? candidates[0];
}

type ActiveTooltip = {source: HTMLElement; trigger: HTMLElement; text: string; original: string | null; composed: string};

export function TooltipLayer() {
  const reactId = useId();
  const tooltipId = `nexus-tooltip-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [active, setActive] = useState<ActiveTooltip>();
  const activeRef = useRef<ActiveTooltip>();
  const dismissed = useRef<HTMLElement>();
  const hideTimer = useRef<number>();
  const frame = useRef<number>();
  const pointer = useRef({type: '', at: 0, x: 0, y: 0});
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const doc = document;
    const win = window;
    const restore = (current: ActiveTooltip) => {
      const value = current.trigger.getAttribute('aria-describedby');
      if (value === current.composed) {
        if (current.original === null) current.trigger.removeAttribute('aria-describedby');
        else current.trigger.setAttribute('aria-describedby', current.original);
      } else if (value) {
        const next = value.split(/\s+/).filter(id => id && id !== tooltipId).join(' ');
        if (next) current.trigger.setAttribute('aria-describedby', next);
        else current.trigger.removeAttribute('aria-describedby');
      }
    };
    const cancelHide = () => {
      if (hideTimer.current !== undefined) {
        win.clearTimeout(hideTimer.current);
        hideTimer.current = undefined;
      }
    };
    const hide = (dismissAnchor?: HTMLElement) => {
      cancelHide();
      const current = activeRef.current;
      if (current) {
        restore(current);
        activeRef.current = undefined;
        setActive(undefined);
      }
      if (dismissAnchor) dismissed.current = dismissAnchor;
    };
    const scheduleHide = (dismissAnchor?: HTMLElement) => {
      cancelHide();
      hideTimer.current = win.setTimeout(() => {
        hideTimer.current = undefined;
        hide(dismissAnchor);
      }, HIDE_DELAY);
    };
    const show = (source: HTMLElement | undefined, trigger = source) => {
      if (!source || !trigger || !source.isConnected || !trigger.isConnected) return;
      if (dismissed.current && (dismissed.current === trigger || dismissed.current.contains(trigger))) return;
      const text = tooltipValue(source);
      if (!text.trim()) return;
      cancelHide();
      const current = activeRef.current;
      if (current?.source === source && current.trigger === trigger && current.text === text) return;
      if (current) restore(current);
      if (dismissed.current && dismissed.current !== trigger && !dismissed.current.contains(trigger)) dismissed.current = undefined;
      const original = trigger.getAttribute('aria-describedby');
      const ids = original?.split(/\s+/).filter(Boolean) ?? [];
      const composed = ids.includes(tooltipId) ? original! : original ? `${original} ${tooltipId}` : tooltipId;
      trigger.setAttribute('aria-describedby', composed);
      const next = {source, trigger, text, original, composed};
      activeRef.current = next;
      setActive(next);
    };
    const anchorContains = (node: EventTarget | null) => {
      const element = asElement(node);
      const current = activeRef.current;
      return Boolean(element && current && (current.trigger.contains(element) || current.source.contains(element)));
    };
    const relatedToCurrent = (node: EventTarget | null | undefined) => {
      const element = asElement(node);
      const current = activeRef.current;
      return Boolean(element && current && (current.trigger.contains(element) || current.source.contains(element)));
    };
    const keepForFocus = () => {
      const current = activeRef.current;
      if (!current) return false;
      if (current.trigger.contains(doc.activeElement)) return true;
      const control = current.trigger.closest(CONTROL_SELECTOR);
      return Boolean(control && control.contains(doc.activeElement));
    };
    const overSurface = (event: {clientX: number; clientY: number}) => {
      const surface = tooltipRef.current;
      if (!surface) return false;
      const rect = surface.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    };
    const triggerFor = (target: Element | null, source: HTMLElement) => {
      if (target && (target === source || source.contains(target))) return source;
      const control = target?.closest<HTMLElement>(CONTROL_SELECTOR);
      return control && control.contains(source) ? control : source;
    };

    const onPointerOver = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.pointerType === 'touch') {
        pointer.current = {type: 'touch', at: Date.now(), x: pointerEvent.clientX, y: pointerEvent.clientY};
        hide();
        return;
      }
      pointer.current = {type: pointerEvent.pointerType || 'mouse', at: Date.now(), x: pointerEvent.clientX, y: pointerEvent.clientY};
      const target = asElement(event.target);
      if ((target && inLayer(target)) || overSurface(pointerEvent)) { cancelHide(); return; }
      const source = resolveTooltipAnchor(target ?? null);
      if (source) { show(source, triggerFor(target ?? null, source)); return; }
      if (target && anchorContains(target)) { cancelHide(); return; }
      if (!keepForFocus()) scheduleHide();
    };
    const onPointerOut = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.pointerType === 'touch') return;
      const target = asElement(event.target);
      const related = asElement((event as MouseEvent).relatedTarget);
      const dismissedAnchor = dismissed.current;
      if (dismissedAnchor && target && (target === dismissedAnchor || dismissedAnchor.contains(target))
        && (!related || !dismissedAnchor.contains(related))) dismissed.current = undefined;
      const current = activeRef.current;
      if (!current) return;
      if (target && inLayer(target)) {
        if (related && (inLayer(related) || relatedToCurrent(related))) { cancelHide(); return; }
        if (keepForFocus()) { cancelHide(); return; }
        hide();
        return;
      }
      if (relatedToCurrent(related)) { cancelHide(); return; }
      if (related && inLayer(related)) { cancelHide(); return; }
      if (keepForFocus()) { cancelHide(); return; }
      scheduleHide();
    };
    const onPointerMove = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.pointerType === 'touch') return;
      pointer.current = {type: pointerEvent.pointerType || 'mouse', at: Date.now(), x: pointerEvent.clientX, y: pointerEvent.clientY};
      if (overSurface(pointerEvent)) { cancelHide(); return; }
      if (frame.current !== undefined) return;
      frame.current = win.requestAnimationFrame(() => {
        frame.current = undefined;
        const point = pointer.current;
        if (point.type === 'touch') return;
        const element = doc.elementFromPoint?.(point.x, point.y) ?? null;
        if (element && inLayer(element)) { cancelHide(); return; }
        const source = resolveTooltipAnchor(element);
        if (source) { show(source, triggerFor(element, source)); return; }
        if (keepForFocus()) { cancelHide(); return; }
        if (activeRef.current) scheduleHide();
      });
    };
    const onPointerDown = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      const target = asElement(event.target);
      if (target && inLayer(target)) return; // Keep a scrollable tooltip usable.
      if (pointerEvent.pointerType === 'touch') {
        pointer.current = {type: 'touch', at: Date.now(), x: pointerEvent.clientX, y: pointerEvent.clientY};
        hide();
        return;
      }
      const current = activeRef.current;
      if (current) hide(current.trigger);
    };
    const onFocusIn = (event: Event) => {
      if (pointer.current.type === 'touch' && Date.now() - pointer.current.at < 1000) return;
      const target = asElement(event.target);
      const source = resolveTooltipAnchor(target ?? null);
      if (source) { show(source, target instanceof HTMLElement ? target : source); return; }
      if (target && anchorContains(target)) { cancelHide(); return; }
      if (activeRef.current) scheduleHide();
    };
    const onFocusOut = (event: Event) => {
      const current = activeRef.current;
      const target = asElement(event.target);
      const related = asElement((event as FocusEvent).relatedTarget);
      const dismissedAnchor = dismissed.current;
      if (dismissedAnchor && target && (target === dismissedAnchor || dismissedAnchor.contains(target))
        && (!related || !dismissedAnchor.contains(related))) dismissed.current = undefined;
      if (!current) return;
      if (target && !current.trigger.contains(target) && !current.source.contains(target)) return;
      if (relatedToCurrent(related)) { cancelHide(); return; }
      scheduleHide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const current = activeRef.current;
      if (current) hide(current.trigger);
    };
    const onScroll = (event: Event) => {
      const target = asElement(event.target);
      if (target && inLayer(target)) return; // Scrolling the tooltip itself is allowed.
      const current = activeRef.current;
      if (current) hide(current.trigger);
    };
    const onResize = () => {
      const current = activeRef.current;
      if (current) hide(current.trigger);
    };
    const onBlur = () => hide();
    const onVisibility = () => { if (doc.hidden) hide(); };
    const onPointerCancel = () => hide();

    const adoptTitle = (element: Element) => {
      if (inLayer(element)) return;
      const title = element.getAttribute('title');
      if (title === null) return;
      element.removeAttribute('title');
      if (!element.hasAttribute(TOOLTIP_ATTRIBUTE) && title.trim()) element.setAttribute(TOOLTIP_ATTRIBUTE, title);
    };
    doc.querySelectorAll('[title]').forEach(adoptTitle);
    const titleObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.type !== 'attributes' || record.attributeName !== 'title') continue;
        const element = record.target;
        if (element instanceof Element) adoptTitle(element);
      }
    });
    titleObserver.observe(doc.documentElement, {attributes: true, attributeFilter: ['title'], subtree: true});

    const focusObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.type !== 'attributes' || record.attributeName !== 'data-gamepad-focus') continue;
        const element = record.target;
        if (!(element instanceof HTMLElement)) continue;
        if (element.hasAttribute('data-gamepad-focus')) {
          const sourceElement = element.matches(CONTROL_SELECTOR) ? element
            : element.contains(doc.activeElement) && doc.activeElement instanceof Element ? doc.activeElement
            : element.querySelector<HTMLElement>(CONTROL_SELECTOR) ?? element;
          const own = element.hasAttribute(TOOLTIP_ATTRIBUTE) && tooltipValue(element).trim() ? element : undefined;
          const source = own ?? resolveTooltipAnchor(sourceElement);
          const trigger = sourceElement instanceof HTMLElement ? sourceElement : element;
          if (source && (activeRef.current?.source !== source || activeRef.current?.trigger !== trigger)) show(source, trigger);
        } else {
          const current = activeRef.current;
          if (current && (current.trigger === element || element.contains(current.trigger))) hide();
        }
      }
    });
    focusObserver.observe(doc.documentElement, {attributes: true, attributeFilter: ['data-gamepad-focus'], subtree: true});

    const disconnectObserver = new MutationObserver(records => {
      const current = activeRef.current;
      if (current && (!current.source.isConnected || !current.trigger.isConnected)) hide();
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.hasAttribute('title')) adoptTitle(node);
          node.querySelectorAll('[title]').forEach(adoptTitle);
        }
      }
    });
    disconnectObserver.observe(doc.body, {childList: true, subtree: true});

    doc.addEventListener('pointerover', onPointerOver, true);
    doc.addEventListener('pointerout', onPointerOut, true);
    doc.addEventListener('pointermove', onPointerMove, {capture: true, passive: true});
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('focusin', onFocusIn, true);
    doc.addEventListener('focusout', onFocusOut, true);
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('scroll', onScroll, true);
    win.addEventListener('resize', onResize);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pointercancel', onPointerCancel, true);

    return () => {
      titleObserver.disconnect();
      focusObserver.disconnect();
      disconnectObserver.disconnect();
      cancelHide();
      if (frame.current !== undefined) win.cancelAnimationFrame(frame.current);
      doc.removeEventListener('pointerover', onPointerOver, true);
      doc.removeEventListener('pointerout', onPointerOut, true);
      doc.removeEventListener('pointermove', onPointerMove, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      doc.removeEventListener('focusout', onFocusOut, true);
      win.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pointercancel', onPointerCancel, true);
      const current = activeRef.current;
      if (current) {
        restore(current);
        activeRef.current = undefined;
      }
    };
  }, [tooltipId]);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!active || !tooltip || !active.source.isConnected || !active.trigger.isConnected) return;
    const anchorRect = active.source.getBoundingClientRect();
    const viewport = {width: window.innerWidth, height: window.innerHeight};
    // Constrain the width before measuring so long localized text wraps at the
    // final viewport width, then place using the resulting height.
    const bounds = placeTooltip({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0}, {width: 0, height: 0}, viewport);
    tooltip.style.maxWidth = `${bounds.maxWidth}px`;
    tooltip.style.maxHeight = `${bounds.maxHeight}px`;
    const rect = tooltip.getBoundingClientRect();
    const size = {width: rect.width || tooltip.offsetWidth, height: rect.height || tooltip.offsetHeight};
    const position = placeTooltip(anchorRect, size, viewport);
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
    tooltip.style.maxWidth = `${position.maxWidth}px`;
    tooltip.style.maxHeight = `${position.maxHeight}px`;
    tooltip.dataset.placement = position.placement;
    tooltip.dataset.scrollable = tooltip.scrollHeight > tooltip.clientHeight + 1 ? 'true' : 'false';
    tooltip.style.visibility = 'visible';
  }, [active]);

  if (!active) return null;
  return createPortal(<div
    ref={tooltipRef}
    id={tooltipId}
    role="tooltip"
    data-tooltip-layer=""
    className="nexus-tooltip"
    style={{visibility: 'hidden'}}
  >{active.text}</div>, document.body);
}
