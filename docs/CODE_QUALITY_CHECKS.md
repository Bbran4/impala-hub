# Code and dependency checks

ESLint runs in CI across frontend and API production files. The TypeScript
unused-variable rule is enabled for imports and local variables; deliberately
unused parameters/catch bindings are allowed. API files also reject explicit
any types. TypeScript checks both browser and API code before production builds.

Scheduler authentication uses timingSafeEqual over fixed-size SHA-256 digests.
Both Marketing and Reporting use the shared check. The Facebook callback uses
FRONTEND_URL, or the origin of the explicitly configured
FACEBOOK_OAUTH_REDIRECT_URI. It does not guess a hardcoded deployment hostname or
trust the request Host header.

Dependency check on 2026-10-31: npm audit against registry.npmjs.org reported
**zero vulnerabilities** for the current lockfile. ExcelJS resolves minimatch
3.1.5 and 5.1.9 through its archive dependencies; development tooling resolves
10.2.6. No broad major-version override was added to suppress advisories.

CI runs npm audit at the moderate threshold so new advisories are visible and
fail the check. Re-run npm audit when updating the lockfile, and validate
spreadsheet import/export tests after changing ExcelJS or archive dependencies.
