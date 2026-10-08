# Plannotator for Qwen Code

This is a native Qwen Code extension for the manual Plannotator workflows:

- Plan review on `exit_plan_mode` (PermissionRequest hook, blocking)
- `plannotator improve-context` on `enter_plan_mode` (PFM reminder injection)
- `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last` (skills)

## Install

Install the `plannotator` CLI first (it must be on `PATH`; the hooks run it as a bare command):

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then install the extension from a Plannotator checkout:

```bash
qwen extensions install /path/to/plannotator/apps/qwen-code
```

`qwen extensions install` copies the extension into your user extensions
(`~/.qwen/extensions/plannotator`), so re-run it after a `git pull` to pick up
changes. To install for a single project, add `--scope project` (it is stored
under the project's `.qwen/extensions`).

Restart Qwen Code, then:

- ask the agent to plan something; when it calls `exit_plan_mode`, Plannotator opens in the browser
- type `/plannotator-review`, `/plannotator-annotate <file>` or `/plannotator-last`

Uninstall with `qwen extensions remove plannotator`.

## Plan review behavior

The hook blocks on `exit_plan_mode` until the reviewer decides:

- **Deny** returns the feedback (annotations, answers, notes) to the model
  immediately; the agent revises and resubmits, opening a fresh review.
- **Approve** is then confirmed once more by Qwen Code's own plan confirmation
  in the terminal. This is a Qwen Code limitation: for tools that always require
  user interaction (`exit_plan_mode` is one), the CLI ignores a hook `allow`
  decision and shows its built-in confirmation. The approve in the browser is
  still what carries the reviewer's annotations and the approved plan text back
  to the agent.

If the `plannotator` command is missing or fails to start, the hook fails open
and Qwen Code shows its built-in plan confirmation instead.

## Skills

The three skills are user-invoked only (`disable-model-invocation: true`); the
model reaches them through your slash commands. They run the CLI with
`PLANNOTATOR_ORIGIN=qwen-code` so the review UI shows the right agent badge and
the session bridge (Ask this session) targets the current Qwen Code session.

## Local development

From a Plannotator checkout, make sure the CLI resolves to this repo:

```bash
bun link
```

Then (re)install the extension from `apps/qwen-code` as above. Rebuild the
bundled HTML after UI changes (`bun run build:hook`).
