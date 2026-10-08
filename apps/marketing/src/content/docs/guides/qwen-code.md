---
title: "Qwen Code"
description: "Native extension, plan review, and the qwen-sdk Ask AI provider for Qwen Code."
sidebar:
  order: 17
section: "Guides"
---

Plannotator supports [Qwen Code](https://github.com/QwenLM/qwen-code) through a native extension:
plan review on `exit_plan_mode`, three `/plannotator-*` skills, and a dedicated `qwen-sdk` Ask AI
provider.

## Setup

Qwen Code is auto-detected. If the `qwen` binary is on your PATH (or `~/.qwen` / `$QWEN_HOME`
exists) when you run the installer, the extension installs automatically — no extra flags or
steps. Install Qwen Code first if you haven't already:

```bash
npm install -g @qwen-code/qwen-code
```

Then run the Plannotator installer for your OS:

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

**Windows CMD:**

```cmd
curl -fsSL https://plannotator.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

The installer fetches the extension source and runs `qwen extensions install <path> --consent`,
replacing any earlier `plannotator` extension (including a hand-made one) in the process. Restart
Qwen Code when it finishes. If you install Qwen Code *after* Plannotator, just re-run the
installer.

Opt out with `--skip-qwen` (PowerShell: `-SkipQwen`), `PLANNOTATOR_SKIP_QWEN_INSTALL=1`, or
`{ "skipInstall": { "qwen": true } }` in `~/.plannotator/config.json`.

## What the extension wires

| Surface | How it works |
|---------|--------------|
| Plan review | A `PermissionRequest` hook on `exit_plan_mode` opens the plan in your browser (blocking, like the classic Claude Code hook) |
| `/plannotator-review` | Code review for the current changes or a pull request |
| `/plannotator-annotate` | Annotate a markdown/HTML file, folder, or URL |
| `/plannotator-last` | Annotate the agent's last message |
| Ask AI | The `qwen-sdk` provider answers from the `qwen` CLI, preferred automatically for Qwen Code sessions |

Plan review is intentionally blocking: Qwen Code always shows its own plan confirmation for
`exit_plan_mode`, so an approve from Plannotator is confirmed once more in the terminal, while a
deny returns the feedback to the model immediately.

## Ask AI with `qwen-sdk`

In any plan review or code review opened from Qwen Code, Ask AI is answered by your own Qwen Code
CLI: one short-lived `qwen` process per question, in read-only plan mode, with the conversation
resumed between questions so follow-ups keep context. The model picker lists the models from your
Qwen `settings.json` (`modelProviders.openai` plus the active `model.name`); pick another one in
Ask AI settings if you want.

## Uninstall

`plannotator uninstall` removes the extension (`qwen extensions uninstall plannotator`) along with
the other recognized components; your plans, history, drafts, and settings are kept.
