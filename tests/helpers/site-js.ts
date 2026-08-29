/**
 * Execute the real authored assets/site.js and hand back its actual functions.
 *
 * Earlier lanes reconstituted individual helpers by extracting each function's
 * source and rebuilding it with `new Function` around a hand-written `esc()`
 * mirror — so the chip-escaping assertions were really testing the test file's
 * copy of `esc`, and could pass while the shipped page escaped nothing. Here the
 * file is evaluated once, whole, and the returned functions are the same closures
 * the browser gets.
 *
 * The bundle is evaluated with an injected `document`/`window`/`fetch`, so
 * nothing leaks into the test process's globals and nothing reaches the network.
 */
import { readFile } from "fs/promises";
import { join } from "path";

export const SITE_JS_PATH = join(process.cwd(), "src", "pages", "static", "assets", "site.js");

/** The site.js exports this repo's tests drive. */
export interface SiteJsApi {
  esc: (value: unknown) => string;
  empty: (message: string) => string;
  emptyListItem: (message: string) => string;
  publicErrorNote: (value: unknown) => string;
  itemCard: (item: Record<string, unknown>, kind?: string) => string;
  calendarWindowFilter: <T>(events: T[] | null, window: string, now?: Date) => T[];
  calendarFreshnessText: (generatedAt: unknown) => string;
  calendarEventKindChip: (event: { kind?: string }, activeFilter?: string) => string;
  calendarEventCard: (event: Record<string, unknown>, summaries?: unknown, activeFilter?: string) => string;
  eventKindFilterValue: (kind: string) => string;
  wireCalendarWindowButtons: (containerId: string, state: { window: string }, onChange: (window: string) => void) => void;
  wireCalendarKindChips: (listId: string, selectId: string, onChange: (value: string) => void) => void;
  createDeferredIndexSearch: (
    loadIndex: () => Promise<unknown>,
    render: (needle: string, index: unknown, state: string) => void,
  ) => { search: (needle: string) => void };
  searchIndexMatches: (index: unknown, needle: string, cap?: number) => unknown[];
}

/** A DOM element stub that records attribute writes and dispatches clicks. */
export interface StubElement {
  id: string;
  className: string;
  attributes: Record<string, string>;
  children: StubElement[];
  textContent: string;
  innerHTML: string;
  value: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  click(): void;
  contains(other: unknown): boolean;
  closest(selector: string): StubElement | null;
  querySelectorAll(selector: string): StubElement[];
}

/**
 * A deliberately small DOM: enough for the calendar wiring (getElementById,
 * querySelectorAll over a class or attribute selector, click listeners,
 * aria-pressed writes) and nothing more. Selector support is limited to
 * `.class` and `[attr]`/`[attr="value"]`, which is all site.js uses.
 */
export function createStubDom(): {
  document: { getElementById: (id: string) => StubElement | null; querySelectorAll: (selector: string) => StubElement[]; addEventListener: () => void };
  element: (id: string, options?: { className?: string; attributes?: Record<string, string>; children?: StubElement[] }) => StubElement;
  register: (element: StubElement) => StubElement;
} {
  const byId = new Map<string, StubElement>();

  const matches = (element: StubElement, selector: string): boolean => {
    const trimmed = selector.trim();
    if (trimmed.startsWith(".")) return element.className.split(/\s+/).includes(trimmed.slice(1));
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(trimmed);
    if (attribute) {
      const value = element.attributes[attribute[1]!];
      if (value === undefined) return false;
      return attribute[2] === undefined || value === attribute[2];
    }
    if (trimmed.startsWith("#")) return element.id === trimmed.slice(1);
    return false;
  };

  const descendants = (element: StubElement): StubElement[] =>
    element.children.flatMap(child => [child, ...descendants(child)]);

  const element = (id: string, options: { className?: string; attributes?: Record<string, string>; children?: StubElement[] } = {}): StubElement => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const node: StubElement = {
      id,
      className: options.className ?? "",
      attributes: { ...(options.attributes ?? {}) },
      children: options.children ?? [],
      textContent: "",
      innerHTML: "",
      value: "",
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name]! : null; },
      addEventListener(type, handler) {
        const existing = listeners.get(type) ?? [];
        existing.push(handler);
        listeners.set(type, existing);
      },
      click() {
        for (const handler of listeners.get("click") ?? []) handler({ target: node });
      },
      contains(other) { return other === node || descendants(node).includes(other as StubElement); },
      closest(selector) {
        if (matches(node, selector)) return node;
        return null;
      },
      querySelectorAll(selector) {
        // Selectors of the shape "#container .window-btn" address descendants.
        const last = selector.split(/\s+/).filter(Boolean).pop() ?? selector;
        return descendants(node).filter(child => matches(child, last));
      },
    };
    if (id) byId.set(id, node);
    return node;
  };

  return {
    document: {
      getElementById: (id: string) => byId.get(id) ?? null,
      querySelectorAll: (selector: string) => {
        const last = selector.split(/\s+/).filter(Boolean).pop() ?? selector;
        return [...byId.values()].flatMap(node => [node, ...descendants(node)]).filter(node => matches(node, last));
      },
      addEventListener: () => {},
    },
    element,
    register: (node: StubElement) => { if (node.id) byId.set(node.id, node); return node; },
  };
}

/**
 * Evaluate the authored site.js and return its real functions. Pass a stub
 * document to drive the wiring helpers; the default stub answers every lookup
 * with null, which is what the pure helpers need.
 */
export async function loadSiteJs(documentStub?: unknown): Promise<SiteJsApi> {
  const source = await readFile(SITE_JS_PATH, "utf8");
  const inert = { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const exportNames = [
    "esc", "empty", "emptyListItem", "publicErrorNote", "itemCard", "calendarWindowFilter",
    "calendarFreshnessText", "calendarEventKindChip", "calendarEventCard", "eventKindFilterValue",
    "wireCalendarWindowButtons", "wireCalendarKindChips", "createDeferredIndexSearch", "searchIndexMatches",
  ];
  const factory = new Function(
    "document",
    "window",
    "fetch",
    `${source}\nreturn { ${exportNames.join(", ")} };`,
  );
  return factory(
    documentStub ?? inert,
    { addEventListener: () => {} },
    () => { throw new Error("site.js tests never touch the network"); },
  ) as SiteJsApi;
}
