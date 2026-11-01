/** Only the element properties exercised by extension page fixtures. */
export interface TestElement {
  textContent: string;
  value: string;
  checked: boolean;
  hidden: boolean;
  className: string;
  disabled?: boolean;
  open?: boolean;
  listeners?: Record<string, () => unknown>;
  append(...children: unknown[]): void;
  replaceChildren(): void;
  setAttribute(...args: unknown[]): void;
  contains?(child?: unknown): boolean;
  addEventListener(name: string, listener: () => unknown): void;
}
