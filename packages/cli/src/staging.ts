/**
 * Temporary directories the CLI creates next to the user's sources. `kivin dev` must ignore them all,
 * so both sides read this one list and a new staging directory cannot be missed.
 */
export const GENERATE_STAGING_PREFIX = '.kivin-gen-';
export const INSPECT_STAGING_PREFIX = '.kivin-inspect-';
export const STAGING_PREFIXES: readonly string[] = [GENERATE_STAGING_PREFIX, INSPECT_STAGING_PREFIX];
