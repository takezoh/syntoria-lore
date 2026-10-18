const defaultProductDisplayName = 'Memory Service';

export function getProductDisplayName(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment['PRODUCT_DISPLAY_NAME'];
  if (configured === undefined) return defaultProductDisplayName;
  const displayName = configured.trim();
  if (
    displayName.length === 0 ||
    displayName.length > 120 ||
    [...displayName].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new Error('PRODUCT_DISPLAY_NAME must be visible text of at most 120 characters');
  }
  return displayName;
}
