/**
 * The e2e suite writes rows, so it gets its own database (testing-verification skill).
 * global-setup.ts provisions it; setup-env.ts points the app's config at it.
 */
export const E2E_DATABASE_NAME = 'geofence_test';
