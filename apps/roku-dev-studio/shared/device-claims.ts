/** One device, one holder: a review job key, or `packager:<project>` for a package run. */
export const PACKAGER_HOLDER = 'packager:';

export function tryClaim(busy: Map<string, string>, key: string, holder: string): boolean {
  if (busy.has(key)) return false;
  busy.set(key, holder);
  return true;
}

export function busyLabel(holder: string): string | undefined {
  return holder.startsWith(PACKAGER_HOLDER) ? `Packaging ${holder.slice(PACKAGER_HOLDER.length)}` : undefined;
}
