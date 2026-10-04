/** Returns the current instant in milliseconds. Injected everywhere so time can be tested. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
