# Bubaly braces depth guard

This package is based on the unmodified npm `braces@3.0.3` publication, retrieved from
`https://registry.npmjs.org/braces/-/braces-3.0.3.tgz` with integrity
`sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`.
The original MIT license is preserved in `LICENSE`; the package name and version are
unchanged so the lockfile does not misrepresent this as an upstream release.
The local package metadata omits upstream-only development dependencies so installing
the runtime package does not add the braces project's test/documentation toolchain to
Bubaly's mobile dependency tree.

The four changed files under `lib/` add a default nesting limit of 100 and consistent
non-negative integer validation for `maxDepth`. Parsing is iterative but now bounds
structural brace/parenthesis nesting. The recursive compile, expand, and stringify
walkers also bound their own depth, including when called with a caller-supplied AST.
Stringify keeps the 3.0.3 parent propagation behavior for `escapeInvalid` compatibility.

This is a local mitigation candidate for GHSA-vfj7-8cjw-p6xm, not an upstream fix or
advisory closure. Keep the advisory visible until upstream publishes a fix and the
dependency/audit gates are independently reconciled. See
`mobile/scripts/braces-depth-guard.test.mjs` for the repository regression checks.

The lockfile installs `mobile/vendor/braces-3.0.3-depth-guard.tgz`, packed from this
source directory. The archive integrity and SHA-256 are recorded alongside the
candidate after confirming repeat packing yields the same digest.

Pinned archive: `braces-3.0.3-depth-guard.tgz` (npm `integrity`:
`sha512-HzjAdl4ATsTgp689enJQEQF9MZvKTmzkr4IktlDULyLLxtJ3D+Qgdhy3BJIWB9NZtB6rcgJtOa+29S6+aQWhkQ==`,
SHA-256 `52755144ACE00BF2519E62055712EFD0C20DA3930FEA7EE63A0375183846511A`). Two
independent `npm pack` runs produced identical SHA-256 values.
