# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-05

### Added

- Public release of `dsh-neocortex`: the Zhinao (second brain) plugin for DeepSeek Harness, with layered Markdown memory (L1 long-term model / L2 knowledge / L3 recent status), a local recall ledger with explanations, lifecycle engine with weekly review, and a Web panel.
- Blank brain template initialization: first run copies a generic, personal-info-free Markdown skeleton into the chosen directory, so a new brain starts from a documented structure.
- Brain takeover: point the plugin at an existing Zhinao directory and adopt it without modifying any existing file.
- Upgrade-skeleton mode: adopt an existing but incomplete Zhinao directory and create only the missing template files — existing files are never touched.

### Notes

- 0.4.0 is the first public release. It carries forward the complete 0.3.0 development-line feature set (the P1–P4 scope validated by the internal acceptance suite); the only functional additions are the template-based setup wizard (new brain / takeover) and the release-candidate packaging. There are no breaking changes relative to a 0.3.0-configured brain.

## [0.4.1] - 2026-11-05

### Added

- npm version and license badges in the READMEs.

### Changed

- Releases now publish through GitHub Actions trusted publishing (OIDC with provenance). Pushing a `v*` tag runs the publish workflow; no long-lived npm tokens are involved.

### Notes

- 0.4.1 was published entirely by CI to validate the automated release pipeline end to end.

## [0.4.2] - 2026-11-06

### Fixed

- Tool results are normalized to lossless JSON before returning. `neocortex_remember` no longer fails on DSH 0.2.2+ with `value is not lossless JSON` when no prior entry was replaced (the report carried `tombstoneId: undefined`). Memory writes were always correct; only the tool report was rejected by the stricter DSH 0.2.2 output validation.

### Notes

- Compatibility verified on DSH 0.2.2-rc.1: plugin load, systemPrompt injection, and all three tools (`neocortex_remember` / `neocortex_recall` / `neocortex_panel`) behave as on 0.2.1-rc.5.
