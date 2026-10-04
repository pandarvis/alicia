/** Renvoie l'instant présent en millisecondes. Injecté partout pour tester le temps. */
export type Horloge = () => number;

export const horlogeSysteme: Horloge = () => Date.now();
