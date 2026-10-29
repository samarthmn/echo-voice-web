declare const __ECHO_BUILD__: string | undefined;
/** Identifies one extension build; set by scripts/build-extension.mjs, "dev" in unit tests. */
export const BUILD_ID = typeof __ECHO_BUILD__ === 'string' ? __ECHO_BUILD__ : 'dev';
