/** The messenger's clock (merge window, row times). Tests move it forward; production uses Date.now. */
let clock: () => number = () => Date.now();
export const messengerClock = (): number => clock();
export const messengerNowIso = (): string => new Date(clock()).toISOString();
export function _setMessengerClock(fn?: () => number): void { clock = fn ?? (() => Date.now()); }
