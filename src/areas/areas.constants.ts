export const AREAS_TABLE = 'areas';

/** Singleton version counter the in-memory polygon snapshot polls (ADR 0012). */
export const AREA_VERSION_TABLE = 'area_version';

/** Cap from CLAUDE.md hard constraints: distinct vertices, the closing repeat excluded. */
export const MAX_POLYGON_VERTICES = 1000;

export const DEFAULT_AREAS_PAGE_SIZE = 50;
export const MAX_AREAS_PAGE_SIZE = 500;
