import { AsyncLocalStorage } from 'node:async_hooks';
// The active project of the request, kept in AsyncLocalStorage so every query helper can scope itself without passing it around.
export const projectScope = new AsyncLocalStorage<number>();
export const P = (): number => projectScope.getStore() as number;
