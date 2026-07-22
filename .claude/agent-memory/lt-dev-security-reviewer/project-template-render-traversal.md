---
name: project-template-render-traversal
description: TemplateService.renderTemplate NOW HAS a path-traversal guard (added ~2026-07-20); Hub sendTestEmail also inventory-validates. Both prior findings FIXED — re-verify before re-reporting.
metadata:
  type: project
---

**UPDATE 2026-07-20 (uncommitted `develop`): BOTH traversal vectors are now guarded. Do NOT re-report the old findings without re-reading the current code.**

`TemplateService.getTemplate()` (`src/core/common/services/template.service.ts`) now resolves `baseDir = resolve(configService.get('templates.path'))` and `fullPath = resolve(baseDir, filePath + '.ejs')`, then throws `Invalid template path` unless `fullPath === baseDir || fullPath.startsWith(baseDir + sep)`. That is a correct absolute-path containment guard — `..` traversal is blocked at the framework level. (Residual: a symlink INSIDE the templates dir pointing out would pass the string check, but that needs filesystem write access, not request input — not a realistic finding.)

Second layer: the Hub's `core-hub-actions.service.ts resolveTestTemplate(template, locale)` now validates `body.template` against `CoreHubEmailService.getTemplates()` inventory (mirrors `renderPreview`'s allowlist) and throws `unknownEmailTemplate` on a miss. So the earlier "sendTestEmail forwards body.template unvalidated" finding is FIXED.

**Why this matters:** my previous version of this memory said renderTemplate had NO guard and flagged sendTestEmail as an active traversal finding — both are now false. The whole traversal class is closed by two independent layers (framework containment guard + Hub allowlist).

**How to apply:** when reviewing any `sendMail`/`renderTemplate` caller, still trace the template-name arg, but the framework guard is now the backstop — a request-controlled name can at worst reach a real `.ejs` inside the templates dir (rendered with server-controlled sample data), not arbitrary filesystem paths. If either guard is later removed/refactored, the traversal class reopens — re-read `template.service.ts` getTemplate() + `resolveTestTemplate()` before relying on this.
