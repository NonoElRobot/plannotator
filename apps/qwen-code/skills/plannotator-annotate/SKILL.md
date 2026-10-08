---
name: plannotator-annotate
disable-model-invocation: true
description: Open Plannotator's annotation UI for a file, folder, or URL, then address the returned annotations.
---

# Plannotator Annotate (Qwen Code)

Run, with the target the user gave after the command (if any):

```bash
PLANNOTATOR_ORIGIN=qwen-code plannotator annotate <target>
```

`<target>` should be a markdown or plain-text config file path (.md, .txt, .yaml, .json, .toml, .ini, .csv, .log, …), folder path, html file path, or URL. Several existing file paths open one review of all of them, in the given order.

If the command reports that the arguments could not be resolved to a file, URL, or folder, work out which target the user means and re-run the command yourself with that concrete path or URL.
